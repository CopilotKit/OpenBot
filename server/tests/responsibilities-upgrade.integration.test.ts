import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { createCredentialStore } from "../src/credentials";
import { applyMigrations } from "../src/db/apply-migrations";
import { createDatabase, type Database } from "../src/db/client";
import { intelligenceCopies, users } from "../src/db/schema";
import {
  responsibilities,
  responsibilityEvents,
  responsibilityRuns,
  responsibilitySourceBindings,
  responsibilityTriggers,
} from "../src/db/schema/responsibilities";
import { responsibilityCopySteps } from "../src/responsibilities/upgrade";
import { createScheduleClient } from "../src/schedules/client";
import {
  copyLocalSchedulesToIntelligence,
  ScheduleCopyMismatchError,
} from "../src/schedules/upgrade";
import { testIntelligence } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * An existing deployment's responsibilities, triggers, bound repositories, events and runs, copied
 * into Intelligence once at boot.
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
const copiedOwners: string[] = [];

function client() {
  return createScheduleClient(testIntelligence());
}

async function freshDeployment(): Promise<Database> {
  const name = `openbot_responsibility_copy_${suite}_${created.length}`;
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
  for (const owner of copiedOwners.splice(0)) await client().purgeOwner(owner);
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

/** A person's responsibilities and their history as the release before this one held them. */
async function legacyResponsibilities(database: Database) {
  const tag = randomUUID().slice(0, 8);
  const owner = `copy-owner-${tag}`;
  copiedOwners.push(owner);
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test`, name: "Owner" });
  const vault = createCredentialStore(database);
  const triggerSecret = await vault.create({
    kind: "connector",
    provider: "webhook-trigger",
    keyId: randomUUID(),
    metadata: { ownerUserId: owner },
    encryptedValue: "sealed",
  });
  const bindingSecret = await vault.create({
    kind: "connector",
    provider: "github-webhook",
    keyId: randomUUID(),
    metadata: { ownerUserId: owner },
    encryptedValue: "sealed",
  });
  const watching = {
    id: randomUUID(),
    ownerUserId: owner,
    agentId: `bot-${tag}`,
    channelId: `channel-${tag}`,
    threadId: `thread-${tag}`,
    title: "Triage deploys",
    instruction: "Summarize each deploy.",
    successCriteria: "A summary is posted.",
    progress: "Read three deploy logs.",
    lastResult: "Deploy 41 went out clean.",
    subscriptions: [{ source: "github" as const, eventType: "push" }],
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    updatedAt: new Date("2026-10-02T11:00:00.000Z"),
  };
  const finished = {
    ...watching,
    id: randomUUID(),
    title: "Ship the launch post",
    status: "completed" as const,
    completedAt: new Date("2026-10-01T09:00:00.000Z"),
    subscriptions: [],
  };
  await database.insert(responsibilities).values([watching, finished]);
  const trigger = {
    id: randomUUID(),
    ownerUserId: owner,
    responsibilityId: watching.id,
    kind: "webhook" as const,
    config: { kind: "webhook" as const, filter: { eventTypes: ["deploy"] } },
    credentialId: triggerSecret.id,
    enabled: false,
    createdAt: new Date("2026-09-02T10:00:00.000Z"),
  };
  await database.insert(responsibilityTriggers).values(trigger);
  const binding = {
    id: randomUUID(),
    ownerUserId: owner,
    source: "github" as const,
    repository: "acme/deploys",
    credentialId: bindingSecret.id,
    createdAt: new Date("2026-09-03T10:00:00.000Z"),
  };
  await database.insert(responsibilitySourceBindings).values(binding);
  const events = [
    {
      id: randomUUID(),
      ownerUserId: owner,
      source: "github" as const,
      externalId: `push-${tag}-1`,
      type: "push",
      payload: { ref: "refs/heads/main" },
      createdAt: new Date("2026-10-01T10:00:00.000Z"),
    },
    {
      id: randomUUID(),
      ownerUserId: owner,
      source: "manual" as const,
      externalId: `manual-${tag}`,
      type: "requested",
      payload: {},
      createdAt: new Date("2026-10-02T10:00:00.000Z"),
    },
  ];
  await database.insert(responsibilityEvents).values(events);
  const waiting = {
    kind: "approval",
    requestId: `approval-${tag}`,
    approvalId: `approval-${tag}`,
    continuation: { toolCallId: "call-1", runId: "run-1", threadId: "t" },
  };
  const runs = [
    {
      id: randomUUID(),
      responsibilityId: watching.id,
      eventId: events[0]?.id ?? "",
      status: "succeeded" as const,
      replyText: "Deploy 41 went out clean.",
      startedAt: new Date("2026-10-01T10:00:05.000Z"),
      finishedAt: new Date("2026-10-01T10:01:00.000Z"),
      createdAt: new Date("2026-10-01T10:00:01.000Z"),
    },
    {
      id: randomUUID(),
      responsibilityId: watching.id,
      eventId: events[1]?.id ?? "",
      status: "waiting" as const,
      error: "Approval required",
      waiting,
      startedAt: new Date("2026-10-02T10:00:05.000Z"),
      createdAt: new Date("2026-10-02T10:00:01.000Z"),
    },
  ];
  await database.insert(responsibilityRuns).values(runs);
  return { owner, watching, finished, trigger, binding, events, runs, waiting };
}

describe("copying a deployment's responsibilities into Intelligence", () => {
  test("every responsibility, trigger, binding, event and run arrives as it was, and the copy records itself", async () => {
    const database = await freshDeployment();
    const legacy = await legacyResponsibilities(database);

    const outcomes = await copyLocalSchedulesToIntelligence(
      database,
      client(),
      responsibilityCopySteps(database),
    );
    expect(outcomes).toEqual([
      { name: "schedules:responsibilities", kind: "copied", local: 2 },
      { name: "schedules:responsibility-triggers", kind: "copied", local: 1 },
      {
        name: "schedules:responsibility-source-bindings",
        kind: "copied",
        local: 1,
      },
      { name: "schedules:responsibility-events", kind: "copied", local: 2 },
      { name: "schedules:responsibility-runs", kind: "copied", local: 2 },
    ]);

    const watching = await client().get("responsibilities", legacy.watching.id);
    expect(watching).toMatchObject({
      ownerUserId: legacy.owner,
      agentId: legacy.watching.agentId,
      channelId: legacy.watching.channelId,
      threadId: legacy.watching.threadId,
      title: "Triage deploys",
      status: "active",
      progress: "Read three deploy logs.",
      lastResult: "Deploy 41 went out clean.",
      subscriptions: [{ source: "github", eventType: "push" }],
      completedAt: null,
      deletedAt: null,
    });
    expect(watching?.createdAt.toISOString()).toBe(
      legacy.watching.createdAt.toISOString(),
    );
    const finished = await client().get("responsibilities", legacy.finished.id);
    expect(finished?.status).toBe("completed");
    expect(finished?.completedAt?.toISOString()).toBe(
      legacy.finished.completedAt.toISOString(),
    );

    // The secret stays in the vault; the trigger and binding name it.
    expect(
      await client().get("responsibility-triggers", legacy.trigger.id),
    ).toMatchObject({
      responsibilityId: legacy.watching.id,
      kind: "webhook",
      config: { kind: "webhook", filter: { eventTypes: ["deploy"] } },
      credentialRef: legacy.trigger.credentialId,
      enabled: false,
    });
    expect(
      await client().get("responsibility-source-bindings", legacy.binding.id),
    ).toMatchObject({
      repository: "acme/deploys",
      credentialRef: legacy.binding.credentialId,
    });

    const events = (
      await client().all("responsibility-events", { ownerUserId: legacy.owner })
    ).items;
    expect(events.map((event) => event.externalId).sort()).toEqual(
      legacy.events.map((event) => event.externalId).sort(),
    );
    // A delivery that arrived before the upgrade is still a duplicate after it.
    expect(
      events.find((event) => event.id === legacy.events[0]?.id)?.payload,
    ).toEqual({ ref: "refs/heads/main" });

    const runs = (
      await client().all("responsibility-runs", {
        responsibilityId: legacy.watching.id,
      })
    ).items;
    const byId = new Map(runs.map((run) => [run.id, run]));
    expect(byId.get(legacy.runs[0]?.id ?? "")).toMatchObject({
      status: "succeeded",
      replyText: "Deploy 41 went out clean.",
    });
    // A run waiting on a person before the upgrade still waits on them after it.
    expect(byId.get(legacy.runs[1]?.id ?? "")).toMatchObject({
      status: "waiting",
      finishedAt: null,
      waiting: legacy.waiting,
    });

    const recorded = await database
      .select()
      .from(intelligenceCopies)
      .where(eq(intelligenceCopies.name, "schedules:responsibility-runs"));
    expect(recorded[0]?.copied).toBe(2);

    // Recorded, so it never runs again: a responsibility later purged in Intelligence stays purged.
    await client().purge("responsibilities", legacy.finished.id);
    const again = await copyLocalSchedulesToIntelligence(
      database,
      client(),
      responsibilityCopySteps(database),
    );
    expect(again.every((step) => step.kind === "done-before")).toBe(true);
    expect(
      await client().get("responsibilities", legacy.finished.id),
    ).toBeNull();
  });

  test("two replicas copying at once copy each record once and both finish", async () => {
    const database = await freshDeployment();
    const legacy = await legacyResponsibilities(database);
    const [first, second] = await Promise.all([
      copyLocalSchedulesToIntelligence(
        database,
        client(),
        responsibilityCopySteps(database),
      ),
      copyLocalSchedulesToIntelligence(
        database,
        client(),
        responsibilityCopySteps(database),
      ),
    ]);
    expect(first).toHaveLength(5);
    expect(second).toHaveLength(5);
    expect(
      (await client().all("responsibilities", { ownerUserId: legacy.owner }))
        .items,
    ).toHaveLength(2);
    expect(
      (
        await client().all("responsibility-runs", {
          responsibilityId: legacy.watching.id,
        })
      ).items,
    ).toHaveLength(2);
    expect(
      (
        await client().all("responsibility-events", {
          ownerUserId: legacy.owner,
        })
      ).items,
    ).toHaveLength(2);
  });

  test("a copy Intelligence does not fully hold stops the boot, loudly, and records nothing", async () => {
    const database = await freshDeployment();
    await legacyResponsibilities(database);
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
        responsibilityCopySteps(database),
      ),
    ).rejects.toBeInstanceOf(ScheduleCopyMismatchError);
    expect(await database.select().from(intelligenceCopies)).toEqual([]);
  });
});
