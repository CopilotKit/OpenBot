import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import {
  createResponsibilityStore,
  RESPONSIBILITY_INGEST_KIND,
  responsibilityRunIdFor,
} from "../src/responsibilities/store";
import {
  ResponsibilityNotFoundError,
  ResponsibilityRefusedError,
} from "../src/responsibilities/types";
import { removeBots, seedBot } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  purgeResponsibilitiesOwnedBy,
  responsibilityEventsFor,
  responsibilityRunsOf,
  storedResponsibilityRun,
  testScheduleClient,
  useTestSchedules,
} from "./support/schedules";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `responsibilities-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const strangerId = `${prefix}-stranger`;
const botId = `${prefix}-bot`;
const channelId = `${prefix}-channel`;
const resolveTarget = async (owner: string, bot: string, channel: string) => {
  const [actor] = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, owner));
  return owner === ownerId && bot === botId && channel === channelId && actor
    ? { threadId: `${prefix}-thread` }
    : null;
};
const store = createResponsibilityStore(database, { resolveTarget });
const runIds: string[] = [];

beforeAll(async () => {
  await useTestSchedules();
  await database.insert(users).values([
    { id: ownerId, email: `${ownerId}@example.test` },
    { id: strangerId, email: `${strangerId}@example.test` },
  ]);
  await seedBot({
    id: botId,
    name: "Responsibility test Bot",
    type: "built_in",
  });
});
afterAll(async () => {
  await database
    .delete(workItems)
    .where(
      and(
        inArray(workItems.kind, [
          "responsibility.run",
          RESPONSIBILITY_INGEST_KIND,
        ]),
        or(
          inArray(sql<string>`${workItems.payload}->>'runId'`, ["", ...runIds]),
          sql`${workItems.payload}->'event'->>'ownerUserId' = ${ownerId}`,
        ),
      ),
    );
  await purgeResponsibilitiesOwnedBy(ownerId);
  await database.delete(users).where(inArray(users.id, [ownerId, strangerId]));
  await removeBots([botId]);
  await database.$client.close();
});
async function goal() {
  return store.create(ownerId, {
    agentId: botId,
    channelId,
    title: "Quarterly graph",
    instruction: "Produce a graphical report",
    successCriteria: "The report has the quarterly graph",
    subscriptions: [{ source: "github", eventType: "issues.opened" }],
  });
}
async function event(id: string, externalId = randomUUID()) {
  const result = await store.ingestEvent({
    ownerUserId: ownerId,
    source: "manual",
    externalId,
    type: "requested",
    responsibilityId: id,
    payload: {},
  });
  runIds.push(...result.runIds);
  return result;
}
async function runItems(runId: string) {
  return database
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.kind, "responsibility.run"),
        sql`${workItems.payload}->>'runId' = ${runId}`,
      ),
    );
}

test("owned lifecycle survives reads and rejects another owner", async () => {
  const value = await goal();
  await expect(store.get(strangerId, value.id)).rejects.toBeInstanceOf(
    ResponsibilityNotFoundError,
  );
  await expect(
    store.update(strangerId, value.id, { title: "stolen" }),
  ).rejects.toBeInstanceOf(ResponsibilityNotFoundError);
  expect((await store.transition(ownerId, value.id, "paused")).status).toBe(
    "paused",
  );
  expect((await store.transition(ownerId, value.id, "active")).status).toBe(
    "active",
  );
  expect(
    (await store.update(ownerId, value.id, { title: "Annual graph" })).title,
  ).toBe("Annual graph");
  await store.transition(ownerId, value.id, "completed");
  await expect(
    store.transition(ownerId, value.id, "active"),
  ).rejects.toBeInstanceOf(ResponsibilityRefusedError);
  // The page's list reads Intelligence: the change is there, most recently changed first.
  const [listed] = await store.list(ownerId);
  expect(listed).toMatchObject({
    id: value.id,
    title: "Annual graph",
    status: "completed",
  });
  expect(listed?.completedAt).toBeInstanceOf(Date);
});

test("competing deliveries atomically produce one event, run and queue item", async () => {
  const value = await goal();
  const externalId = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 4 }, () => event(value.id, externalId)),
  );
  expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
  const runId = results.find((result) => !result.duplicate)?.runIds[0];
  if (!runId) throw new Error("Expected a queued run.");
  expect(new Set(results.map((result) => result.eventId)).size).toBe(1);
  expect(await responsibilityEventsFor(ownerId, externalId)).toHaveLength(1);
  expect(await responsibilityRunsOf(value.id)).toHaveLength(1);
  expect((await storedResponsibilityRun(runId))?.status).toBe("queued");
  const items = await runItems(runId);
  expect(items.map((item) => item.key)).toEqual([runId]);
  // Every outbox item is finished: nothing is left for the work loop to redo.
  const outbox = await database
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.kind, RESPONSIBILITY_INGEST_KIND),
        sql`${workItems.payload}->'event'->>'externalId' = ${externalId}`,
      ),
    );
  expect(outbox).toHaveLength(4);
  expect(outbox.every((item) => item.finishedAt !== null)).toBe(true);
  const contexts = await Promise.all([
    store.beginRun(runId),
    store.beginRun(runId),
  ]);
  expect(contexts.filter(Boolean)).toHaveLength(1);
  expect((await storedResponsibilityRun(runId))?.status).toBe("running");
});

test("pause before dispatch prevents the selected Bot from being run", async () => {
  const value = await goal();
  const result = await event(value.id);
  const runId = result.runIds[0];
  if (!runId) throw new Error("Expected a queued run.");
  await store.transition(ownerId, value.id, "paused");
  expect(await store.beginRun(runId)).toBeNull();
  expect((await store.listRuns(ownerId, value.id))[0]?.status).toBe("skipped");
});

test("waiting response resumes the same run once with stored pending tool context", async () => {
  const value = await goal();
  const result = await event(value.id);
  const runId = result.runIds[0];
  if (!runId) throw new Error("Expected a queued run.");
  await store.beginRun(runId);
  await store.recordProgress(
    ownerId,
    value.id,
    { summary: "Drew the first chart.", sourceRunId: runId },
    botId,
  );
  const waiting = {
    kind: "approval",
    requestId: "approval-1",
    continuation: {
      toolCallId: "call-1",
      runId: "agui-run-1",
      threadId: `${prefix}-thread`,
      args: { target: "save" },
    },
  };
  await store.settleRun(runId, {
    status: "waiting",
    waiting,
    error: "Approval required",
  });
  // Progress only comes from the current run, and a waiting run is not running.
  await expect(
    store.recordProgress(ownerId, value.id, {
      summary: "Late.",
      sourceRunId: runId,
    }),
  ).rejects.toBeInstanceOf(ResponsibilityRefusedError);
  await expect(
    store.resumeWaiting(strangerId, runId, "yes"),
  ).rejects.toBeInstanceOf(ResponsibilityNotFoundError);
  const resumed = await Promise.all([
    store.resumeWaiting(ownerId, runId, { approved: true }),
    store.resumeWaiting(ownerId, runId, { approved: true }),
  ]);
  expect(resumed.filter(Boolean)).toHaveLength(1);
  // One item for the first dispatch and one for the resume, never a second for the resume.
  expect(
    (await runItems(runId)).filter((item) => item.finishedAt === null),
  ).toHaveLength(2);
  const context = await store.beginRun(runId);
  expect(context?.runId).toBe(runId);
  expect(context?.progress).toBe("Drew the first chart.");
  expect(context?.continuation).toEqual({
    waiting,
    response: { approved: true },
  });
  await store.settleRun(runId, {
    status: "succeeded",
    replyText: "Graph rendered.",
  });
  expect((await store.get(ownerId, value.id)).lastResult).toBe(
    "Graph rendered.",
  );
  await expect(
    store.settleRun(runId, { status: "failed", error: "again" }),
  ).rejects.toBeInstanceOf(ResponsibilityRefusedError);
  expect((await storedResponsibilityRun(runId))?.status).toBe("succeeded");
});

test("a run whose worker died while it ran is failed, not replayed", async () => {
  const value = await goal();
  const runId = (await event(value.id)).runIds[0];
  if (!runId) throw new Error("Expected a queued run.");
  expect(await store.beginRun(runId)).not.toBeNull();
  expect(await store.beginRun(runId, { recovered: true })).toBeNull();
  expect(await storedResponsibilityRun(runId)).toMatchObject({
    status: "failed",
    error: expect.stringContaining("The worker stopped during this run."),
  });
});

test("an event a process accepted and died on is finished by the work loop, exactly once", async () => {
  const value = await goal();
  const client = testScheduleClient();
  const eventId = randomUUID();
  const accepted = {
    ownerUserId: ownerId,
    source: "manual" as const,
    externalId: randomUUID(),
    type: "requested",
    responsibilityId: value.id,
    payload: { note: "accepted before the crash" },
  };
  // The process wrote its outbox item, created the event in Intelligence, and stopped there: no
  // run, no run item, and its lease on the item already run out.
  await database.insert(workItems).values({
    kind: RESPONSIBILITY_INGEST_KIND,
    key: eventId,
    payload: { eventId, event: accepted },
    claimedBy: "a-process-that-died",
    leaseUntil: new Date(Date.now() - 1_000),
    attempts: 1,
  });
  await client.create("responsibility-events", {
    id: eventId,
    ownerUserId: ownerId,
    source: accepted.source,
    externalId: accepted.externalId,
    type: accepted.type,
    payload: accepted.payload,
  });
  // The delivery arriving again meanwhile is the same event, and starts nothing of its own.
  const again = await store.ingestEvent(accepted);
  expect(again).toMatchObject({ eventId, duplicate: true });

  const recovered = await store.recover({ owner: `${prefix}-loop` });
  expect(recovered.ingests).toBeGreaterThanOrEqual(1);
  const runId = responsibilityRunIdFor(value.id, eventId);
  runIds.push(runId);
  expect(await storedResponsibilityRun(runId)).toMatchObject({
    eventId,
    responsibilityId: value.id,
    status: "queued",
  });
  expect((await runItems(runId)).map((item) => item.key)).toEqual([runId]);
  const [item] = await database
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.kind, RESPONSIBILITY_INGEST_KIND),
        eq(workItems.key, eventId),
      ),
    );
  expect(item?.finishedAt).toBeInstanceOf(Date);
  // A second pass changes nothing: the same run, the same single item.
  await store.recover({ owner: `${prefix}-loop` });
  expect(await responsibilityRunsOf(value.id)).toHaveLength(1);
  expect(await runItems(runId)).toHaveLength(1);
});

test("a queued run left without an item is offered one, once, by the work loop", async () => {
  const value = await goal();
  const result = await event(value.id);
  const firstRun = result.runIds[0];
  if (!firstRun) throw new Error("Expected a queued run.");
  const client = testScheduleClient();
  // A run moved back to queued by a resume whose process died before offering its item, minutes ago.
  const strandedEvent = randomUUID();
  await client.create("responsibility-events", {
    id: strandedEvent,
    ownerUserId: ownerId,
    source: "manual",
    externalId: randomUUID(),
    type: "requested",
    payload: {},
  });
  const stranded = responsibilityRunIdFor(value.id, strandedEvent);
  runIds.push(stranded);
  const longAgo = new Date(Date.now() - 10 * 60_000);
  expect(
    await client.importRecords("responsibility-runs", [
      {
        id: stranded,
        responsibilityId: value.id,
        eventId: strandedEvent,
        status: "queued",
        createdAt: longAgo,
        updatedAt: longAgo,
      },
    ]),
  ).toBe(1);
  // A fresh store, so its first pass reconciles rather than waiting for the minute.
  const loop = createResponsibilityStore(database, { resolveTarget });
  const { requeued } = await loop.recover({ owner: `${prefix}-loop` });
  expect(requeued).toContain(stranded);
  // A run that has its item already is left alone.
  expect(requeued).not.toContain(firstRun);
  expect((await runItems(stranded)).map((item) => item.key)).toEqual([
    stranded,
  ]);
  const second = createResponsibilityStore(database, { resolveTarget });
  expect((await second.recover({ owner: `${prefix}-loop` })).requeued).toEqual(
    [],
  );
  expect(await runItems(stranded)).toHaveLength(1);
  expect((await store.beginRun(stranded))?.runId).toBe(stranded);
});

test("nothing a responsibility does writes to the legacy tables", async () => {
  const counts = async () =>
    (
      await database.execute<{ total: number }>(sql`
        select (select count(*) from responsibilities)
          + (select count(*) from responsibility_events)
          + (select count(*) from responsibility_runs)
          + (select count(*) from responsibility_triggers)
          + (select count(*) from responsibility_source_bindings) as total`)
    )[0]?.total;
  const before = await counts();
  const value = await goal();
  const runId = (await event(value.id)).runIds[0];
  if (!runId) throw new Error("Expected a queued run.");
  await store.update(ownerId, value.id, { title: "Weekly graph" });
  await store.beginRun(runId);
  await store.recordProgress(ownerId, value.id, { summary: "Halfway." });
  await store.settleRun(runId, { status: "succeeded", replyText: "Done." });
  await store.listRuns(ownerId, value.id);
  await store.list(ownerId);
  await store.transition(ownerId, value.id, "completed");
  expect(await counts()).toEqual(before);
});
