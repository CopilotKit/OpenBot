import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { applyMigrations } from "../src/db/apply-migrations";
import { createDatabase, type Database } from "../src/db/client";
import {
  intelligenceCopies,
  routineRuns,
  routines,
  users,
} from "../src/db/schema";
import { routineCopySteps } from "../src/routines/upgrade";
import { createScheduleClient } from "../src/schedules/client";
import {
  copyLocalSchedulesToIntelligence,
  ScheduleCopyMismatchError,
} from "../src/schedules/upgrade";
import { testIntelligence } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * An existing deployment's routines and runs, copied into Intelligence once at boot.
 *
 * Each test gets a fresh database with every migration applied and rows written the way the release
 * before this one wrote them, then runs the copy the server runs at boot, from one replica and from
 * two at once.
 */
const server = new URL(testDatabaseUrl());
const administrative = new URL(server.href);
administrative.pathname = "/postgres";
const suite = randomUUID().slice(0, 8);
const migrations = join(import.meta.dir, "..", "drizzle");
const created: string[] = [];
const opened: Database[] = [];
const copiedRoutines: string[] = [];

function client() {
  return createScheduleClient(testIntelligence());
}

async function freshDeployment(): Promise<Database> {
  const name = `openbot_routine_copy_${suite}_${created.length}`;
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  created.push(name);
  const url = new URL(server.href);
  url.pathname = `/${name}`;
  const raw = postgres(url.href, { max: 1, onnotice: () => {} });
  try {
    await applyMigrations(raw, migrations);
  } finally {
    await raw.end({ timeout: 5 });
  }
  const database = createDatabase(url.href, TEST_POOL);
  opened.push(database);
  return database;
}

afterEach(async () => {
  for (const database of opened.splice(0)) await database.$client.close();
  for (const id of copiedRoutines.splice(0))
    await client().purge("routines", id);
});

afterAll(async () => {
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    for (const name of created)
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}, 60_000);

/** Two routines and their history as the release before this one held them. */
async function legacyRoutines(database: Database) {
  const tag = randomUUID().slice(0, 8);
  const owner = `copy-owner-${tag}`;
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test`, name: "Owner" });
  const due = new Date("2031-05-04T09:00:00.000Z");
  const enabledAt = new Date("2026-10-01T08:00:00.000Z");
  const daily = {
    id: `routine_${randomUUID()}`,
    ownerUserId: owner,
    agentId: `bot-${tag}`,
    channelId: `channel-${tag}`,
    instruction: "Post the standup summary.",
    cron: "0 9 * * *",
    timezone: "Europe/Berlin",
    enabled: true,
    nextRunAt: due,
    lastRunAt: new Date("2031-05-03T07:00:00.000Z"),
    enabledAt,
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
  };
  const paused = {
    ...daily,
    id: `routine_${randomUUID()}`,
    instruction: "Review the week.",
    cron: "0 16 * * 5",
    enabled: false,
    lastRunAt: null,
  };
  await database.insert(routines).values([daily, paused]);
  copiedRoutines.push(daily.id, paused.id);
  const runs = [
    {
      id: `routine_run_${randomUUID()}`,
      routineId: daily.id,
      status: "succeeded" as const,
      startedAt: new Date("2031-05-03T07:00:01.000Z"),
      finishedAt: new Date("2031-05-03T07:01:30.000Z"),
      source: "schedule" as const,
    },
    {
      id: `routine_run_${randomUUID()}`,
      routineId: daily.id,
      status: "failed" as const,
      error: "the integration is down",
      startedAt: new Date("2031-05-02T07:00:01.000Z"),
      finishedAt: new Date("2031-05-02T07:00:40.000Z"),
      source: "schedule" as const,
    },
    {
      id: `routine_run_${randomUUID()}`,
      routineId: daily.id,
      status: "waiting" as const,
      waiting: { approvalId: `approval-${tag}` },
      startedAt: new Date("2031-05-01T07:00:01.000Z"),
      source: "run_now" as const,
    },
  ];
  await database.insert(routineRuns).values(runs);
  return { owner, daily, paused, runs };
}

describe("copying a deployment's routines into Intelligence", () => {
  test("every routine and run arrives as it was, and the copy records itself", async () => {
    const database = await freshDeployment();
    const legacy = await legacyRoutines(database);

    const outcomes = await copyLocalSchedulesToIntelligence(
      database,
      client(),
      routineCopySteps(database),
    );
    expect(outcomes).toEqual([
      { name: "schedules:routines", kind: "copied", local: 2 },
      { name: "schedules:routine-runs", kind: "copied", local: 3 },
    ]);

    const daily = await client().get("routines", legacy.daily.id);
    expect(daily).toMatchObject({
      ownerUserId: legacy.owner,
      agentId: legacy.daily.agentId,
      channelId: legacy.daily.channelId,
      instruction: "Post the standup summary.",
      cron: "0 9 * * *",
      timezone: "Europe/Berlin",
      enabled: true,
      deletedAt: null,
    });
    // The clock as it was: a routine due at nine fires at nine on the first sweep after the upgrade.
    expect(daily?.nextRunAt.toISOString()).toBe(
      legacy.daily.nextRunAt.toISOString(),
    );
    expect(daily?.enabledAt.toISOString()).toBe(
      legacy.daily.enabledAt.toISOString(),
    );
    expect(daily?.createdAt.toISOString()).toBe(
      legacy.daily.createdAt.toISOString(),
    );
    const paused = await client().get("routines", legacy.paused.id);
    expect(paused?.enabled).toBe(false);

    const runs = (
      await client().all("routine-runs", { routineId: legacy.daily.id })
    ).items;
    expect(runs.map((run) => run.id).sort()).toEqual(
      legacy.runs.map((run) => run.id).sort(),
    );
    const byId = new Map(runs.map((run) => [run.id, run]));
    expect(byId.get(legacy.runs[1]?.id ?? "")).toMatchObject({
      status: "failed",
      error: "the integration is down",
    });
    expect(byId.get(legacy.runs[2]?.id ?? "")).toMatchObject({
      status: "waiting",
      source: "run_now",
      finishedAt: null,
      waiting: { approvalId: expect.any(String) },
    });

    const recorded = await database
      .select()
      .from(intelligenceCopies)
      .where(eq(intelligenceCopies.name, "schedules:routines"));
    expect(recorded[0]?.copied).toBe(2);

    // Recorded, so it never runs again: a routine later purged in Intelligence stays purged.
    await client().purge("routines", legacy.paused.id);
    const again = await copyLocalSchedulesToIntelligence(
      database,
      client(),
      routineCopySteps(database),
    );
    expect(again.map((step) => step.kind)).toEqual([
      "done-before",
      "done-before",
    ]);
    expect(await client().get("routines", legacy.paused.id)).toBeNull();
  });

  test("two replicas copying at once copy each record once and both finish", async () => {
    const database = await freshDeployment();
    const legacy = await legacyRoutines(database);

    const [first, second] = await Promise.all([
      copyLocalSchedulesToIntelligence(
        database,
        client(),
        routineCopySteps(database),
      ),
      copyLocalSchedulesToIntelligence(
        database,
        client(),
        routineCopySteps(database),
      ),
    ]);
    for (const outcome of [first, second])
      expect(outcome.every((step) => step.kind !== undefined)).toBe(true);
    const runs = (
      await client().all("routine-runs", { routineId: legacy.daily.id })
    ).items;
    expect(runs).toHaveLength(3);
    expect(
      (await client().all("routines", { ownerUserId: legacy.owner })).items,
    ).toHaveLength(2);
  });

  test("a copy Intelligence does not fully hold stops the boot, loudly, and records nothing", async () => {
    const database = await freshDeployment();
    await legacyRoutines(database);
    // Intelligence answering that it holds fewer of the records than were sent.
    const real = client();
    const short = {
      importRecords: async (
        collection: Parameters<typeof real.importRecords>[0],
        records: Parameters<typeof real.importRecords>[1],
      ) => (await real.importRecords(collection, records)) - 1,
    };
    await expect(
      copyLocalSchedulesToIntelligence(
        database,
        short,
        routineCopySteps(database),
      ),
    ).rejects.toBeInstanceOf(ScheduleCopyMismatchError);
    expect(await database.select().from(intelligenceCopies)).toEqual([]);
  });
});
