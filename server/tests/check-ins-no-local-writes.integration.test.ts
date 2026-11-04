/**
 * Check-ins live in Intelligence now: this deployment's five check-in tables get no writes.
 *
 * `proactive_settings`, `proactive_runs`, `proactive_people`, `proactive_pings` and
 * `proactive_suggestions` stay for one release so an upgrading deployment has rows to copy, and are
 * read only by that copy. A write that still landed in one would be a check-in Intelligence never
 * heard of, run for nobody, or an item the person is never shown. Two guards: no server source outside
 * the copy names any of the five, and a check-in's whole life through the store (turned on, changed,
 * claimed, run, an item raised, pinged, started, put back, cleared, the ledger pruned, a Bot reset,
 * turned off and removed) leaves all five as they were while Intelligence holds every step.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { count, inArray } from "drizzle-orm";
import { createBotReset } from "../src/agents/lifecycle-reset";
import { createDatabase } from "../src/db/client";
import {
  proactivePeople,
  proactivePings,
  proactiveRuns,
  proactiveSettings,
  proactiveSuggestions,
  users,
} from "../src/db/schema";
import { createMemoryDefaults } from "../src/memory/defaults";
import { createProactiveStore } from "../src/proactive/store";
import { removeBots, seedBot } from "./support/bots";
import {
  freeSlot,
  itemsOf,
  makeDue,
  pingsOf,
  purgeSchedulesOf,
  settingsOf,
} from "./support/check-ins";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testMemory } from "./support/memory";
import { testScheduleClient, useTestSchedules } from "./support/schedules";
import { sourceFiles, stripComments } from "./support/source-scan";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `check-ins-no-local-writes-${suite}`;
const bot = `check-ins-no-local-writes-bot-${suite}`;
const otherBot = `check-ins-no-local-writes-other-${suite}`;

afterAll(async () => {
  await purgeSchedulesOf([owner]);
  await removeBots([bot, otherBot]);
  await database.delete(users).where(inArray(users.id, [owner]));
  await database.$client.close();
});

async function tableCounts() {
  const total = async (
    table:
      | typeof proactiveSettings
      | typeof proactiveRuns
      | typeof proactivePeople
      | typeof proactivePings
      | typeof proactiveSuggestions,
  ) => (await database.select({ total: count() }).from(table))[0]?.total;
  return {
    settings: await total(proactiveSettings),
    runs: await total(proactiveRuns),
    people: await total(proactivePeople),
    pings: await total(proactivePings),
    suggestions: await total(proactiveSuggestions),
  };
}

describe("the legacy check-in tables", () => {
  test("no server source names them except the upgrade copy and the schema", () => {
    const root = join(import.meta.dir, "..", "src");
    const allowed = new Set(["proactive/upgrade.ts", "db/schema/proactive.ts"]);
    const offenders = sourceFiles(root, [".ts"]).flatMap((file) => {
      const path = relative(root, file);
      if (allowed.has(path)) return [];
      const code = stripComments(readFileSync(file, "utf8"));
      return /\bproactive(?:Settings|Runs|People|Pings|Suggestions)\b/.test(
        code,
      )
        ? [path]
        : [];
    });
    expect(offenders).toEqual([]);
  });

  test("a check-in's whole life through the store writes nothing to them", async () => {
    await useTestSchedules();
    await database
      .insert(users)
      .values({ id: owner, email: `${owner}@example.test`, name: "Owner" });
    await seedBot({ id: bot, name: "Inbox Bot", type: "built_in" });
    await seedBot({ id: otherBot, name: "Diary Bot", type: "built_in" });
    const store = createProactiveStore(database);
    const before = await tableCounts();

    // Turned on by default on the person's first turn, and by hand for a second Bot.
    const defaults = createMemoryDefaults({
      database,
      memory: testMemory(database).store,
      ingestion: {
        defaultSourceCandidates: async () => [],
        sync: async () => undefined as never,
      },
      sources: false,
      research: true,
      channelBots: async () => [bot],
      canDeliver: async () => true,
      mintThreadId: () => `thread-${randomUUID()}`,
      minIntervalMs: 0,
      log: () => {},
    });
    expect(await defaults.adoptResearch(owner, bot, `channel-${suite}`)).toBe(
      true,
    );
    const [adopted] = await settingsOf(owner);
    if (!adopted) throw new Error("The default setting was not made.");
    const second = await store.create(
      owner,
      { agentId: otherBot, channelId: `other-channel-${suite}` },
      `thread-${randomUUID()}`,
    );
    await store.update(owner, adopted.id, {
      focus: "Billing",
      intervalMinutes: 120,
    });

    // Claimed, run, an item raised, the run closed.
    await makeDue(adopted.id);
    const [claimed] = (await store.claimDue(10)).filter(
      (setting) => setting.id === adopted.id,
    );
    expect(claimed?.id).toBe(adopted.id);
    const runId = randomUUID();
    expect(
      await store.beginRun({
        id: runId,
        setting: claimed as NonNullable<typeof claimed>,
        trigger: "schedule",
        threadId: `run-thread-${suite}`,
        // Room for every run this test starts: the daily cap is another test's subject.
        dailyLimit: 1000,
      }),
    ).toBe(true);
    await store.recordRun(adopted.id, "running");
    const raised = await store.raise(
      {
        ownerUserId: owner,
        agentId: bot,
        settingId: adopted.id,
        runId,
        title: "Reply to Dana about Friday",
        detail: "Dana asked whether Friday still works.",
        sourceApp: "Mail",
        sourceRef: "mail/list_messages",
        sourceLink: null,
      },
      () => null,
    );
    const later = await store.addSuggestion({
      ownerUserId: owner,
      agentId: bot,
      settingId: adopted.id,
      runId,
      title: "Book the venue",
      detail: "The offsite needs a room.",
      sourceApp: "Mail",
      sourceRef: "mail/list_messages",
      sourceLink: null,
    });
    await store.finishRun(runId, {
      outcome: "raised",
      itemsRaised: 2,
      reads: 1,
    });
    await store.recordRun(adopted.id, "succeeded");
    await store.skipRun({
      id: randomUUID(),
      setting: second,
      trigger: "run_now",
      reason: "no_sources",
    });

    // Pinged, offered; started and put back; one cleared, one hidden.
    await freeSlot(owner);
    const ping = await store.pings.take(owner);
    expect(ping?.items.map((item) => item.title).sort()).toEqual([
      "Book the venue",
      "Reply to Dana about Friday",
    ]);
    await store.pings.markOffered(ping?.pingId as string);
    await store.resolveSuggestion(owner, raised.id, "started");
    await store.reopenSuggestion(owner, raised.id);
    await store.clearSuggestion(adopted.id, later.id);
    await store.resolveSuggestion(owner, raised.id, "dismissed");
    await store.closeStaleRuns(10 * 60_000);
    await store.prune();
    await store.update(owner, second.id, { enabled: false });

    // A Bot reset takes the first; removing takes the second.
    await createBotReset({
      database,
      memory: testMemory(database).store,
      softDeleteChannel: async () => {},
    }).execute({ id: owner, role: "user" }, bot);
    await store.remove(owner, second.id);

    expect(await tableCounts()).toEqual(before);
    // Intelligence held every step: both settings gone for good, the ping kept as the person's newest.
    expect(await settingsOf(owner)).toEqual([]);
    expect(await itemsOf(owner)).toEqual([]);
    expect((await pingsOf(owner)).map((held) => held.id)).toEqual([
      ping?.pingId as string,
    ]);
    expect(
      (await testScheduleClient().get("check-in-people", owner))?.lastPingedAt,
    ).toBeInstanceOf(Date);
  });
});
