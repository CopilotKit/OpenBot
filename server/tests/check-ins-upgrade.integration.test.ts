import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { applyMigrations } from "../src/db/apply-migrations";
import { createDatabase, type Database } from "../src/db/client";
import {
  intelligenceCopies,
  proactivePeople,
  proactivePings,
  proactiveRuns,
  proactiveSettings,
  proactiveSuggestions,
  users,
} from "../src/db/schema";
import { unreachedError } from "../src/proactive/store";
import { checkInCopySteps } from "../src/proactive/upgrade";
import { createScheduleClient } from "../src/schedules/client";
import {
  copyLocalSchedulesToIntelligence,
  ScheduleCopyMismatchError,
} from "../src/schedules/upgrade";
import { testIntelligence } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * An existing deployment's check-ins, copied into Intelligence once at boot.
 *
 * Each test gets a fresh database with every migration applied and rows written the way the release
 * before this one wrote them (settings, the run ledger, each person's ping slot, the pings and the
 * items they carried), then runs the copy the server runs at boot, from one replica and from two at
 * once. What must hold: every field crosses, so the first sweep after the upgrade claims a check-in
 * when it was due, nobody is pinged twice in the hour, a ping never offered is still offered once, and
 * an item carried by a ping is not carried again; running it again copies nothing twice; and once
 * recorded it never runs again, so a record purged in Intelligence later does not come back.
 */
const server = new URL(testDatabaseUrl());
const administrative = new URL(server.href);
administrative.pathname = "/postgres";
const suite = randomUUID().slice(0, 8);
const migrations = join(import.meta.dir, "..", "drizzle");
const created: string[] = [];
const opened: Database[] = [];
const owners: string[] = [];

function client() {
  return createScheduleClient(testIntelligence());
}

async function freshDeployment(): Promise<Database> {
  const name = `openbot_check_in_copy_${suite}_${created.length}`;
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
  for (const owner of owners.splice(0)) await client().purgeOwner(owner);
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

/** One person's check-ins and their history as the release before this one held them. */
async function legacyCheckIns(database: Database) {
  const tag = randomUUID().slice(0, 8);
  const owner = `copy-owner-${tag}`;
  owners.push(owner);
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test`, name: "Owner" });
  const inbox = {
    id: randomUUID(),
    ownerUserId: owner,
    agentId: `inbox-bot-${tag}`,
    channelId: `inbox-channel-${tag}`,
    threadId: `inbox-thread-${tag}`,
    focus: "Invoices and contracts",
    enabled: true,
    intervalMinutes: 120,
    nextRunAt: new Date("2031-05-04T09:00:00.000Z"),
    lastRunAt: new Date("2031-05-04T07:00:00.000Z"),
    lastStatus: "succeeded" as const,
    lastError: null,
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    updatedAt: new Date("2031-05-04T07:01:00.000Z"),
  };
  // Turned off, its last check-in having failed: kept off, with what went wrong.
  const diary = {
    ...inbox,
    id: randomUUID(),
    agentId: `diary-bot-${tag}`,
    channelId: `diary-channel-${tag}`,
    threadId: `diary-thread-${tag}`,
    focus: "",
    enabled: false,
    intervalMinutes: 60,
    lastStatus: "error" as const,
    lastError: "Couldn't reach Calendar.",
  };
  await database.insert(proactiveSettings).values([inbox, diary]);
  const runs = [
    {
      id: randomUUID(),
      settingId: inbox.id,
      ownerUserId: owner,
      agentId: inbox.agentId,
      threadId: `run-thread-${tag}-1`,
      trigger: "schedule" as const,
      outcome: "raised" as const,
      itemsRaised: 2,
      reads: 4,
      startedAt: new Date("2031-05-04T07:00:00.000Z"),
      finishedAt: new Date("2031-05-04T07:01:00.000Z"),
    },
    {
      id: randomUUID(),
      settingId: inbox.id,
      ownerUserId: owner,
      agentId: inbox.agentId,
      threadId: `run-thread-${tag}-2`,
      trigger: "run_now" as const,
      outcome: "failed" as const,
      reads: 1,
      error: unreachedError(["Calendar"]),
      startedAt: new Date("2031-05-04T05:00:00.000Z"),
      finishedAt: new Date("2031-05-04T05:00:30.000Z"),
    },
    {
      id: randomUUID(),
      settingId: diary.id,
      ownerUserId: owner,
      agentId: diary.agentId,
      threadId: null,
      trigger: "schedule" as const,
      outcome: "skipped" as const,
      skipReason: "paused" as const,
      startedAt: new Date("2031-05-03T05:00:00.000Z"),
      finishedAt: new Date("2031-05-03T05:00:00.000Z"),
    },
  ];
  await database.insert(proactiveRuns).values(runs);
  const pingedAt = new Date("2031-05-04T07:01:00.000Z");
  await database.insert(proactivePeople).values({
    ownerUserId: owner,
    lastPingedAt: pingedAt,
    createdAt: new Date("2031-04-01T00:00:00.000Z"),
    updatedAt: pingedAt,
  });
  const offered = {
    id: randomUUID(),
    ownerUserId: owner,
    itemCount: 1,
    text: "One thing needs you\n• Inbox Bot: Pay the invoice.",
    pushBody: "Inbox Bot: Pay the invoice",
    createdAt: new Date("2031-05-03T07:01:00.000Z"),
    offeredAt: new Date("2031-05-03T07:01:02.000Z"),
  };
  // Written, then the replica stopped before delivery: still to be offered, word for word.
  const unoffered = {
    id: randomUUID(),
    ownerUserId: owner,
    itemCount: 1,
    text: "One thing needs you\n• Inbox Bot: Reply to Dana.",
    pushBody: "Inbox Bot: Reply to Dana",
    createdAt: pingedAt,
    offeredAt: null,
  };
  await database.insert(proactivePings).values([offered, unoffered]);
  const item = (title: string, extra: Record<string, unknown>) => ({
    id: randomUUID(),
    ownerUserId: owner,
    agentId: inbox.agentId,
    settingId: inbox.id,
    runId: runs[0]?.id as string,
    title,
    detail: `${title}. They asked this morning.`,
    sourceApp: "Mail",
    sourceRef: "mail/list_messages",
    sourceLink: "https://mail.example.test/m/1",
    createdAt: new Date("2031-05-03T07:00:30.000Z"),
    ...extra,
  });
  const items = [
    item("Pay the invoice", {
      status: "dismissed",
      dedupeKey: "pay the invoice",
      pingId: offered.id,
      deliveredAt: offered.createdAt,
      resolvedAt: new Date("2031-05-03T08:00:00.000Z"),
    }),
    item("Reply to Dana", {
      status: "open",
      dedupeKey: "reply to dana",
      pingId: unoffered.id,
      deliveredAt: pingedAt,
      createdAt: new Date("2031-05-04T07:00:30.000Z"),
    }),
    // From before items kept a normalized title, never pinged yet.
    item("Book the venue", {
      status: "open",
      dedupeKey: null,
      sourceLink: null,
      createdAt: new Date("2031-05-04T07:00:40.000Z"),
    }),
  ];
  await database.insert(proactiveSuggestions).values(items);
  return {
    owner,
    inbox,
    diary,
    runs,
    pingedAt,
    offered,
    unoffered,
    items,
  };
}

const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;

describe("copying a deployment's check-ins into Intelligence", () => {
  test("every setting, run, slot, ping and item arrives as it was, and the copy records itself", async () => {
    const database = await freshDeployment();
    const legacy = await legacyCheckIns(database);

    const outcomes = await copyLocalSchedulesToIntelligence(
      database,
      client(),
      checkInCopySteps(database),
    );
    expect(outcomes).toEqual([
      { name: "schedules:check-in-settings", kind: "copied", local: 2 },
      { name: "schedules:check-in-runs", kind: "copied", local: 3 },
      { name: "schedules:check-in-people", kind: "copied", local: 1 },
      { name: "schedules:check-in-pings", kind: "copied", local: 2 },
      { name: "schedules:check-in-suggestions", kind: "copied", local: 3 },
    ]);

    const inbox = await client().get("check-in-settings", legacy.inbox.id);
    expect(inbox).toMatchObject({
      ownerUserId: legacy.owner,
      agentId: legacy.inbox.agentId,
      channelId: legacy.inbox.channelId,
      threadId: legacy.inbox.threadId,
      focus: "Invoices and contracts",
      enabled: true,
      intervalMinutes: 120,
      lastStatus: "succeeded",
      lastError: null,
      deletedAt: null,
    });
    // The clock as it was: a check-in due at nine is claimed at nine on the first sweep after it.
    expect(iso(inbox?.nextRunAt)).toBe(iso(legacy.inbox.nextRunAt));
    expect(iso(inbox?.lastRunAt)).toBe(iso(legacy.inbox.lastRunAt));
    expect(iso(inbox?.createdAt)).toBe(iso(legacy.inbox.createdAt));
    expect(
      await client().get("check-in-settings", legacy.diary.id),
    ).toMatchObject({
      enabled: false,
      lastStatus: "error",
      lastError: "Couldn't reach Calendar.",
    });

    const runs = new Map(
      (
        await client().all("check-in-runs", { ownerUserId: legacy.owner })
      ).items.map((run) => [run.id, run]),
    );
    expect([...runs.keys()].sort()).toEqual(
      legacy.runs.map((run) => run.id).sort(),
    );
    const [raised, failed, skipped] = legacy.runs;
    expect(runs.get(raised?.id as string)).toMatchObject({
      outcome: "raised",
      trigger: "schedule",
      itemsRaised: 2,
      reads: 4,
      error: null,
      threadId: raised?.threadId,
    });
    // What the next check-in's window reads: a failed one names the apps it couldn't reach.
    expect(runs.get(failed?.id as string)).toMatchObject({
      outcome: "failed",
      trigger: "run_now",
      error: unreachedError(["Calendar"]),
    });
    expect(runs.get(skipped?.id as string)).toMatchObject({
      outcome: "skipped",
      skipReason: "paused",
      threadId: null,
    });
    expect(iso(runs.get(raised?.id as string)?.startedAt)).toBe(
      iso(raised?.startedAt),
    );

    // The slot as it was: nobody is pinged twice in the hour the upgrade lands in.
    expect(
      iso((await client().get("check-in-people", legacy.owner))?.lastPingedAt),
    ).toBe(iso(legacy.pingedAt));
    const pings = new Map(
      (
        await client().all("check-in-pings", { ownerUserId: legacy.owner })
      ).items.map((ping) => [ping.id, ping]),
    );
    expect(pings.get(legacy.offered.id)).toMatchObject({
      itemCount: 1,
      text: legacy.offered.text,
      pushBody: legacy.offered.pushBody,
    });
    expect(iso(pings.get(legacy.offered.id)?.offeredAt)).toBe(
      iso(legacy.offered.offeredAt),
    );
    // Never offered before the upgrade: the ping pass still offers it, word for word.
    expect(pings.get(legacy.unoffered.id)).toMatchObject({
      offeredAt: null,
      text: legacy.unoffered.text,
    });
    expect(iso(pings.get(legacy.unoffered.id)?.createdAt)).toBe(
      iso(legacy.unoffered.createdAt),
    );

    const items = new Map(
      (
        await client().all("check-in-suggestions", {
          ownerUserId: legacy.owner,
        })
      ).items.map((item) => [item.title, item]),
    );
    expect(items.get("Pay the invoice")).toMatchObject({
      status: "dismissed",
      dedupeKey: "pay the invoice",
      pingId: legacy.offered.id,
      sourceApp: "Mail",
      sourceRef: "mail/list_messages",
      sourceLink: "https://mail.example.test/m/1",
    });
    // Carried by a ping already, so it is not carried again; and still open, so still on the list.
    expect(items.get("Reply to Dana")).toMatchObject({
      status: "open",
      pingId: legacy.unoffered.id,
      deliveredAt: expect.any(Date),
    });
    expect(items.get("Book the venue")).toMatchObject({
      status: "open",
      dedupeKey: null,
      pingId: null,
      sourceLink: null,
    });

    const recorded = await database
      .select()
      .from(intelligenceCopies)
      .where(eq(intelligenceCopies.name, "schedules:check-in-suggestions"));
    expect(recorded[0]?.copied).toBe(3);

    // Recorded, so it never runs again: a setting later purged in Intelligence stays purged.
    await client().purge("check-in-settings", legacy.diary.id);
    const again = await copyLocalSchedulesToIntelligence(
      database,
      client(),
      checkInCopySteps(database),
    );
    expect(again.map((step) => step.kind)).toEqual([
      "done-before",
      "done-before",
      "done-before",
      "done-before",
      "done-before",
    ]);
    expect(await client().get("check-in-settings", legacy.diary.id)).toBeNull();
  });

  test("two replicas copying at once copy each record once and both finish", async () => {
    const database = await freshDeployment();
    const legacy = await legacyCheckIns(database);

    const [first, second] = await Promise.all([
      copyLocalSchedulesToIntelligence(
        database,
        client(),
        checkInCopySteps(database),
      ),
      copyLocalSchedulesToIntelligence(
        database,
        client(),
        checkInCopySteps(database),
      ),
    ]);
    for (const outcome of [first, second]) expect(outcome).toHaveLength(5);
    const holds = async (
      collection:
        | "check-in-settings"
        | "check-in-runs"
        | "check-in-pings"
        | "check-in-suggestions",
    ) =>
      (await client().all(collection, { ownerUserId: legacy.owner })).items
        .length;
    expect(await holds("check-in-settings")).toBe(2);
    expect(await holds("check-in-runs")).toBe(3);
    expect(await holds("check-in-pings")).toBe(2);
    expect(await holds("check-in-suggestions")).toBe(3);
  });

  test("a copy Intelligence does not fully hold stops the boot, loudly, and records nothing", async () => {
    const database = await freshDeployment();
    await legacyCheckIns(database);
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
        checkInCopySteps(database),
      ),
    ).rejects.toBeInstanceOf(ScheduleCopyMismatchError);
    expect(await database.select().from(intelligenceCopies)).toEqual([]);
  });
});
