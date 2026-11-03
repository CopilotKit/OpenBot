/**
 * Check-ins held in memory per instance, with Intelligence the truth: what happens when an instance's
 * memory is behind, an announcement is lost, or a write's answer is lost on the way back.
 *
 * Each case builds a second schedule directory of its own, as another replica would have, against the
 * same test Intelligence, and installs it for the length of the case so the real store reads through
 * it. Those built with no gateway hear no announcements, which is what an instance whose subscription
 * dropped looks like until its next full read.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { createMemoryDefaults } from "../src/memory/defaults";
import { createProactiveStore } from "../src/proactive/store";
import { createScheduleClient } from "../src/schedules/client";
import {
  createScheduleDirectory,
  installScheduleDirectory,
  type ScheduleDirectory,
} from "../src/schedules/directory";
import { removeBots, seedBot, testIntelligence } from "./support/bots";
import {
  makeDue,
  purgeSchedulesOf,
  runsOf,
  settingsOf,
} from "./support/check-ins";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testScheduleClient, useTestSchedules } from "./support/schedules";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createProactiveStore(database);
const suite = randomUUID().slice(0, 8);
const owner = `check-ins-replicas-${suite}`;
const bot = `check-ins-replicas-bot-${suite}`;
const otherBot = `check-ins-replicas-other-${suite}`;
let main: ScheduleDirectory;
const replicas: ScheduleDirectory[] = [];

beforeAll(async () => {
  main = await useTestSchedules();
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await seedBot({ id: bot, name: "Inbox Bot", type: "built_in" });
  await seedBot({ id: otherBot, name: "Diary Bot", type: "built_in" });
});
afterEach(async () => {
  for (const directory of replicas.splice(0)) directory.stop();
  installScheduleDirectory(main);
  await purgeSchedulesOf([owner]);
});
afterAll(async () => {
  await removeBots([bot, otherBot]);
  await database.delete(users).where(eq(users.id, owner));
  await database.$client.close();
});

/**
 * Another instance's directory, started and installed in place of this process's: no announcements
 * reach it, and `fetch` sees every request it makes, when given.
 */
async function replica(fetch?: typeof globalThis.fetch) {
  const intelligence = testIntelligence();
  const directory = createScheduleDirectory({
    client: createScheduleClient({
      apiUrl: intelligence.apiUrl,
      apiKey: intelligence.apiKey,
      ...(fetch ? { fetch } : {}),
    }),
    resyncIntervalMs: 3_600_000,
  });
  await directory.start();
  replicas.push(directory);
  installScheduleDirectory(directory);
  return directory;
}

const turnOn = (agentId: string) =>
  store.create(
    owner,
    { agentId, channelId: `channel-${agentId}` },
    `thread-${randomUUID()}`,
  );

describe("an instance whose memory is behind", () => {
  test("claims nothing another replica already claimed, and reads the moved clock back", async () => {
    const setting = await turnOn(bot);
    const due = await makeDue(setting.id);
    const behind = await replica();
    expect(behind.peek("check-in-settings", setting.id)?.nextRunAt).toEqual(
      due.nextRunAt,
    );
    // Another replica claims the hour first; this one has not heard.
    const moved = await testScheduleClient().advance(
      "check-in-settings",
      setting.id,
      due.nextRunAt,
      new Date(Date.now() + 60 * 60_000),
    );
    expect(moved).not.toBeNull();
    expect(behind.peek("check-in-settings", setting.id)?.nextRunAt).toEqual(
      due.nextRunAt,
    );

    expect(
      (await store.claimDue(10)).some((claimed) => claimed.id === setting.id),
    ).toBe(false);
    // Refused on the stale clock, it read the setting again: the next sweep sees the truth.
    expect(behind.peek("check-in-settings", setting.id)?.nextRunAt).toEqual(
      moved?.nextRunAt,
    );
    expect(
      (await store.claimDue(10)).some((claimed) => claimed.id === setting.id),
    ).toBe(false);
  });

  test("a change the person made on another replica under an older version is redone on the newer one", async () => {
    const setting = await turnOn(bot);
    const behind = await replica();
    // The sweep on another replica moved the clock: this instance's version is now one behind.
    const due = await makeDue(setting.id);
    expect(behind.peek("check-in-settings", setting.id)?.version).toBeLessThan(
      due.version,
    );
    const changed = await store.update(owner, setting.id, { focus: "Billing" });
    expect(changed.focus).toBe("Billing");
    // The clock the other replica moved is kept, not put back to what this instance remembered.
    expect(changed.nextRunAt).toEqual(due.nextRunAt);
  });
});

describe("a lost announcement", () => {
  test("a setting made on another replica is claimed once this instance reads everything again", async () => {
    const behind = await replica();
    // Made and made due on another replica; the announcement never reaches this one.
    const made = await testScheduleClient().create("check-in-settings", {
      id: randomUUID(),
      ownerUserId: owner,
      agentId: otherBot,
      channelId: `channel-${otherBot}`,
      threadId: `thread-${randomUUID()}`,
      focus: "",
      enabled: true,
      intervalMinutes: 60,
      nextRunAt: new Date(Date.now() - 1_000),
      lastRunAt: null,
      lastStatus: "idle",
      lastError: null,
    });
    expect(
      (await store.claimDue(10)).some((claimed) => claimed.id === made.id),
    ).toBe(false);
    // The timer's full read (or a rejoin) heals it.
    await behind.resync();
    expect(
      (await store.claimDue(10)).some((claimed) => claimed.id === made.id),
    ).toBe(true);
  });

  test("a setting removed on another replica stops being claimed after the next full read", async () => {
    const setting = await turnOn(bot);
    const behind = await replica();
    await makeDue(setting.id);
    await behind.resync();
    await testScheduleClient().purge("check-in-settings", setting.id);
    await behind.resync();
    expect(behind.peek("check-in-settings", setting.id)).toBeUndefined();
    expect(
      (await store.claimDue(10)).some((claimed) => claimed.id === setting.id),
    ).toBe(false);
  });
});

describe("a write whose answer was lost", () => {
  /**
   * A transport that delivers each request, but loses the first answer to every write it is told to:
   * Intelligence did the work, and this instance never heard.
   */
  function losingFirstAnswers(lose: (method: string, url: string) => boolean) {
    const lost = new Set<string>();
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      const method = init?.method ?? "GET";
      const url = String(input);
      const key = `${method} ${url} ${String(init?.body ?? "")}`;
      if (lose(method, url) && !lost.has(key)) {
        lost.add(key);
        throw new TypeError("fetch failed: the connection was reset");
      }
      return response;
    }) as typeof fetch;
  }

  test("starting a check-in, raising an item and taking the slot each happen once", async () => {
    const setting = await turnOn(bot);
    await replica(
      losingFirstAnswers(
        (method, url) =>
          method === "POST" &&
          (url.endsWith("/check-in-runs") ||
            url.endsWith("/check-in-suggestions") ||
            url.endsWith("/check-in-pings/take")),
      ),
    );
    const runId = randomUUID();
    // Retried under the same key: the replay of the first, not a second running check-in.
    expect(
      await store.beginRun({
        id: runId,
        setting,
        trigger: "schedule",
        threadId: `thread-${randomUUID()}`,
      }),
    ).toBe(true);
    expect((await runsOf(setting.id)).map((run) => run.outcome)).toEqual([
      "running",
    ]);
    const item = await store.raise(
      {
        ownerUserId: owner,
        agentId: bot,
        settingId: setting.id,
        runId,
        title: "Reply to Dana about Friday",
        detail: "Dana asked whether Friday still works.",
        sourceApp: "Mail",
        sourceRef: "mail/list_messages",
        sourceLink: null,
      },
      () => null,
    );
    const items = (
      await testScheduleClient().all("check-in-suggestions", {
        ownerUserId: owner,
      })
    ).items;
    expect(items.map((held) => held.id)).toEqual([item.id]);
    const ping = await store.pings.take(owner);
    expect(ping?.items.map((carried) => carried.suggestionId)).toEqual([
      item.id,
    ]);
    expect(
      (await testScheduleClient().all("check-in-pings", { ownerUserId: owner }))
        .items,
    ).toHaveLength(1);
  });
});

describe("a person's turn", () => {
  test("never reaches Intelligence when they already have check-ins with the Bot", async () => {
    await turnOn(bot);
    let asked = 0;
    await replica((async (input: RequestInfo | URL, init?: RequestInit) => {
      asked += 1;
      return fetch(input, init);
    }) as typeof fetch);
    asked = 0;
    const defaults = createMemoryDefaults({
      database,
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
    expect(await defaults.adoptResearch(owner, bot, `channel-${bot}`)).toBe(
      false,
    );
    expect(asked).toBe(0);
    // Without one, it makes one: the only time a turn reaches Intelligence.
    expect(
      await defaults.adoptResearch(owner, otherBot, `channel-${otherBot}`),
    ).toBe(true);
    expect(asked).toBeGreaterThan(0);
    expect(
      (await settingsOf(owner)).map((setting) => setting.agentId).sort(),
    ).toEqual([bot, otherBot].sort());
  });

  test("two replicas adopting at once make one setting", async () => {
    const first = createMemoryDefaults({
      database,
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
    const results = await Promise.all([
      first.adoptResearch(owner, bot, `channel-${bot}`),
      first.adoptResearch(owner, bot, `channel-${bot}`),
      first.adoptResearch(owner, bot, `channel-${bot}`),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await settingsOf(owner)).toHaveLength(1);
  });
});
