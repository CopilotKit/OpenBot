import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { startRetentionSweeps } from "../src/audit-retention";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { createProactiveStore } from "../src/proactive/store";
import { removeBots, seedBot } from "./support/bots";
import { pingsOf, runsOfPerson } from "./support/check-ins";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testScheduleClient, useTestSchedules } from "./support/schedules";

/*
 * The check-in ledger and old pings are pruned on the retention schedule, whatever the audit policy
 * is, without dropping anything a check-in or the app still reads: a ping an open item names (which
 * keeps that item from being pinged again), and each person's newest ping. The ledger and the pings
 * are Intelligence's; the scene is set by copying records in with the dates they would have had.
 */

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const store = createProactiveStore(database);
const client = testScheduleClient();
const suite = randomUUID().slice(0, 8);
const owner = `ledger-owner-${suite}`;
const bot = `ledger-bot-${suite}`;
const settingId = `ledger-setting-${suite}`;

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

const setting = {
  id: settingId,
  ownerUserId: owner,
  agentId: bot,
  channelId: `ledger-channel-${suite}`,
  threadId: `ledger-thread-${suite}`,
  focus: "",
  enabled: true,
  intervalMinutes: 60,
  nextRunAt: new Date("2100-01-01T00:00:00Z"),
  lastRunAt: null,
  lastStatus: "idle",
  lastError: null,
};

beforeAll(async () => {
  await useTestSchedules();
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await seedBot({ id: bot, name: "Ledger Bot", type: "built_in" });
});
beforeEach(async () => {
  // Everything this person had, gone, then their one setting again.
  await client.purgeOwner(owner);
  await client.importRecords("check-in-settings", [setting]);
});
afterAll(async () => {
  await client.purgeOwner(owner);
  await database.delete(users).where(eq(users.id, owner));
  await removeBots([bot]);
  await database.$client.close();
});

async function run(name: string, days: number, outcome: "quiet" | "running") {
  await client.importRecords("check-in-runs", [
    {
      id: `${suite}-${name}`,
      settingId,
      ownerUserId: owner,
      agentId: bot,
      threadId: null,
      trigger: "schedule",
      outcome,
      skipReason: null,
      itemsRaised: 0,
      reads: 0,
      error: null,
      startedAt: daysAgo(days),
      finishedAt: outcome === "running" ? null : daysAgo(days),
      createdAt: daysAgo(days),
    },
  ]);
}
async function ping(name: string, days: number) {
  await client.importRecords("check-in-pings", [
    {
      id: `${suite}-${name}`,
      ownerUserId: owner,
      itemCount: 1,
      text: "One thing needs you",
      pushBody: "One thing needs you",
      createdAt: daysAgo(days),
      offeredAt: daysAgo(days),
    },
  ]);
}
async function itemOf(pingName: string, status: "open" | "dismissed") {
  const id = `${suite}-item-${pingName}`;
  await client.importRecords("check-in-suggestions", [
    {
      id,
      ownerUserId: owner,
      agentId: bot,
      settingId,
      runId: `${suite}-run`,
      title: `Item for ${pingName}`,
      detail: "Why.",
      sourceApp: null,
      sourceRef: null,
      sourceLink: null,
      status,
      dedupeKey: null,
      pingId: `${suite}-${pingName}`,
      deliveredAt: null,
      resolvedAt: status === "open" ? null : new Date(),
    },
  ]);
  return id;
}
const runIds = async () =>
  (await runsOfPerson(owner))
    .map((row) => row.id.slice(suite.length + 1))
    .sort();
const pingIds = async () =>
  (await pingsOf(owner)).map((row) => row.id.slice(suite.length + 1)).sort();

describe("pruning the check-in ledger", () => {
  test("finished runs older than 30 days go; recent ones and one still running stay", async () => {
    await run("old", 31, "quiet");
    await run("stuck", 40, "running");
    await run("recent", 29, "quiet");
    await store.prune();
    expect(await runIds()).toEqual(["recent", "stuck"]);
  });

  test("an old ping goes unless an open item names it or it is the person's newest", async () => {
    await ping("old-hidden", 50);
    await ping("old-open", 45);
    await ping("old-bare", 40);
    await ping("old-unread", 35);
    await ping("recent", 5);
    const hiddenItem = await itemOf("old-hidden", "dismissed");
    await itemOf("old-open", "open");
    expect(await store.prune()).toMatchObject({ pings: 3 });
    expect(await pingIds()).toEqual(["old-open", "recent"]);
    // The hidden item keeps its record, without the ping.
    expect(await client.get("check-in-suggestions", hiddenItem)).toMatchObject({
      status: "dismissed",
      pingId: null,
    });
    // The open item still names its ping, so it is never pinged a second time.
    expect(await store.pings.take(owner)).toBeNull();
  });

  test("a person whose pings are all old keeps their newest", async () => {
    await ping("older", 60);
    await ping("newest", 40);
    await store.prune();
    expect(await pingIds()).toEqual(["newest"]);
  });

  test("the retention schedule prunes it on a deployment with no audit retention set", async () => {
    await run("old", 45, "quiet");
    await ping("older", 60);
    await ping("newest", 40);
    const sweeps = startRetentionSweeps(undefined, {
      firstRunMs: 10,
      intervalMs: 3_600_000,
      proactive: store,
    });
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await runIds()).length === 0 && (await pingIds()).length === 1)
          break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      sweeps.stop();
    }
    expect(await runIds()).toEqual([]);
    expect(await pingIds()).toEqual(["newest"]);
  });
});
