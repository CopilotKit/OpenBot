import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { proactiveRuns } from "../src/db/schema/proactive";
import { createProactiveStore } from "../src/proactive/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createProactiveStore(database);
const prefix = `check-in-concurrency-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const secondBot = `${prefix}-second`;

beforeAll(async () => {
  await database
    .insert(users)
    .values([owner, other].map((id) => ({ id, email: `${id}@example.test` })));
  await database.insert(agents).values(
    [bot, secondBot].map((id) => ({
      id,
      name: id,
      type: "built_in" as const,
      configuration: {},
    })),
  );
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.delete(agents).where(inArray(agents.id, [bot, secondBot]));
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
  await database.insert(proactiveRuns).values(
    [
      { setting: first, outcome: "quiet" as const },
      { setting: second, outcome: "failed" as const },
      { setting: second, outcome: "skipped" as const },
      { setting: anotherBot, outcome: "quiet" as const },
      { setting: anotherOwner, outcome: "quiet" as const },
    ].map(({ setting: row, outcome }) => ({
      id: randomUUID(),
      settingId: row.id,
      ownerUserId: row.ownerUserId,
      agentId: row.agentId,
      trigger: "schedule" as const,
      outcome,
      finishedAt: new Date(),
      skipReason: outcome === "skipped" ? ("capped" as const) : null,
    })),
  );
  await database.insert(proactiveRuns).values({
    id: randomUUID(),
    settingId: first.id,
    ownerUserId: owner,
    agentId: bot,
    trigger: "schedule",
    outcome: "quiet",
    finishedAt: new Date(),
    startedAt: new Date(Date.now() - 25 * 60 * 60_000),
  });
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
