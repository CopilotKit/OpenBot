import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { createProactiveStore } from "../src/proactive/store";
import { purgeSchedulesOf } from "./support/check-ins";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testScheduleClient, useTestSchedules } from "./support/schedules";

// Check-in settings and their runs are Intelligence's (support/schedules.ts); the people stay here.
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createProactiveStore(database);
const prefix = `check-in-concurrency-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const secondBot = `${prefix}-second`;

beforeAll(async () => {
  await useTestSchedules();
  await database
    .insert(users)
    .values([owner, other].map((id) => ({ id, email: `${id}@example.test` })));
});
afterAll(async () => {
  await purgeSchedulesOf([owner, other]);
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.$client.close();
});

async function setting(subject: string, agentId = bot, person = owner) {
  return store.create(
    person,
    { agentId, channelId: `${prefix}-channel`, subject },
    randomUUID(),
  );
}

test("concurrent acceptance creates one schedule per target, while distinct targets stay separate", async () => {
  const accepted = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      store.create(
        owner,
        {
          agentId: bot,
          channelId: `${prefix}-channel`,
          subject: index % 2 ? "Inbox" : "inbox",
        },
        randomUUID(),
      ),
    ),
  );
  expect(new Set(accepted.map((row) => row.id)).size).toBe(1);
  const linked = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      store.create(
        owner,
        {
          agentId: bot,
          channelId: `${prefix}-channel`,
          subject: `Document ${index}`,
          sourceLink: "https://example.test/document",
        },
        randomUUID(),
      ),
    ),
  );
  expect(new Set(linked.map((row) => row.id)).size).toBe(1);
  const distinct = await setting("Another subject");
  expect(distinct.id).not.toBe(accepted[0]?.id);
  expect(distinct.id).not.toBe(linked[0]?.id);
});

test("daily counts combine a Bot's settings, exclude skipped/old runs and isolate owners and Bots", async () => {
  const first = await setting("Count one");
  const second = await setting("Count two");
  const anotherBot = await setting("Other Bot", secondBot);
  const anotherOwner = await setting("Other owner", bot, other);
  const client = testScheduleClient();
  const run = async (
    row: { id: string; ownerUserId: string; agentId: string },
    outcome: "quiet" | "failed" | "skipped",
    startedAt = new Date(),
  ) =>
    client.create("check-in-runs", {
      id: randomUUID(),
      settingId: row.id,
      ownerUserId: row.ownerUserId,
      agentId: row.agentId,
      threadId: null,
      trigger: "schedule",
      outcome,
      skipReason: outcome === "skipped" ? "capped" : null,
      itemsRaised: 0,
      reads: 0,
      error: null,
      startedAt,
      finishedAt: new Date(),
    });
  await run(first, "quiet");
  await run(second, "failed");
  await run(second, "skipped");
  await run(anotherBot, "quiet");
  await run(anotherOwner, "quiet");
  await run(first, "quiet", new Date(Date.now() - 25 * 60 * 60_000));
  expect(await store.runsToday(owner, bot)).toBe(2);
  expect(await store.runsToday(owner, secondBot)).toBe(1);
  expect(await store.runsToday(other, bot)).toBe(1);
});

test("concurrent settings reserve only the remaining daily slot", async () => {
  const settings = await Promise.all([
    setting("Race one", secondBot, other),
    setting("Race two", secondBot, other),
  ]);
  const results = await Promise.all(
    settings.map((row) =>
      store.beginRun({
        id: randomUUID(),
        setting: row,
        trigger: "schedule",
        threadId: randomUUID(),
        dailyLimit: 1,
      }),
    ),
  );
  expect(results.filter((result) => result === true)).toHaveLength(1);
  expect(results.filter((result) => result === "capped")).toHaveLength(1);
  expect(await store.runsToday(other, secondBot)).toBe(1);
});
