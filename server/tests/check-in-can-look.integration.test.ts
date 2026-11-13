import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema";
import { proactiveRuns, proactiveSettings } from "../src/db/schema/proactive";
import type { ProactiveSkipReason } from "../src/proactive/contracts";
import { createProactiveEngine } from "../src/proactive/engine";
import { proactiveInitiator } from "../src/proactive/restriction";
import type { CheckInApp, CheckInSource } from "../src/proactive/scope";
import { createProactiveStore } from "../src/proactive/store";
import type { ProactiveSetting } from "../src/proactive/types";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A check-in that exists can look, and when it stops being able to, the person is told where they
 * already look. FOUND IN AN AUDIT: a check-in could be made, by the Bot's offer or by New routine,
 * for something it could never read, and was then skipped on every run with nobody told.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createProactiveStore(database);
const prefix = `can-look-${randomUUID().slice(0, 8)}`;
const owner = `${prefix}-owner`;
const bot = `${prefix}-bot`;

const gmail: CheckInApp = {
  title: "Gmail",
  serverId: "gmail",
  refs: ["gmail/list_messages"],
  names: ["mcp__gmail__list_messages"],
};
const notion: CheckInApp = {
  title: "Notion",
  serverId: "notion",
  refs: ["notion/fetch"],
  names: ["mcp__notion__fetch"],
};
const SOURCES: Record<string, CheckInSource> = {
  mcp__gmail__list_messages: { kind: "app", ...gmail },
  mcp__notion__fetch: { kind: "app", ...notion },
  mcp__parallel__web_fetch: { kind: "page" },
  "mcp__slack-shared__history": {
    kind: "unreadable",
    serverId: "slack-shared",
    title: "Slack",
  },
};

/** What the Bot can read this moment, which a test changes. */
const world = {
  apps: [gmail, notion] as CheckInApp[],
  reader: { ref: "parallel/web_fetch", name: "mcp__parallel__web_fetch" } as {
    ref: string;
    name: string;
  } | null,
  usable: true,
};
let clock = Date.now();

function engineNow() {
  return createProactiveEngine({
    store,
    queue: createWorkQueue(database),
    owner: `${prefix}-proactive`,
    runTurn: async () => ({ replyText: "" }),
    canUseBot: async () => world.usable,
    readableApps: async () => world.apps,
    pageReader: async () => world.reader,
    sourceOf: async (_owner, _agent, name) => SOURCES[name] ?? null,
    botName: async () => "Inbox Bot",
    attention: { notifyAttention: async () => {} },
    catalogue: {
      listServers: async () => [
        { id: "gmail", title: "Gmail", tools: [] },
        { id: "notion", title: "Notion", tools: [] },
      ],
    },
    mintThreadId: () => `${prefix}-thread-${randomUUID()}`,
    // Each engine starts a minute later, so `health`'s minute-long memory never carries over.
    now: () => new Date(clock),
  });
}
let engine = engineNow();

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await database.insert(agents).values({
    id: bot,
    name: "Inbox Bot",
    type: "built_in",
    configuration: {},
  });
});
afterEach(async () => {
  world.apps = [gmail, notion];
  world.reader = {
    ref: "parallel/web_fetch",
    name: "mcp__parallel__web_fetch",
  };
  world.usable = true;
  clock += 2 * 60_000;
  engine = engineNow();
  await database
    .delete(proactiveSettings)
    .where(eq(proactiveSettings.ownerUserId, owner));
});
afterAll(async () => {
  await database.delete(agents).where(inArray(agents.id, [bot]));
  await database.delete(users).where(eq(users.id, owner));
  await database.$client.close();
});

const create = (input: Record<string, unknown>) =>
  engine.create(owner, { agentId: bot, ...input });

test("each way a check-in could never look is refused at create, with what to do", async () => {
  world.apps = [];
  await expect(create({ subject: "Your apps" })).rejects.toThrow(
    "This Bot can't read any app you've connected. Connect one in Connections first.",
  );
  await expect(
    create({ subject: "Team chat", readWith: "mcp__slack-shared__history" }),
  ).rejects.toThrow("This Bot can't read Slack as you. Connect Slack first.");
  await expect(
    create({ subject: "Inbox", readWith: "mcp__gmail__list_messages" }),
  ).rejects.toThrow("This Bot can't read Gmail as you. Connect Gmail first.");
  await expect(
    create({ subject: "A page", readWith: "computer_snapshot" }),
  ).rejects.toThrow("this Bot read that another way");

  for (const sourceLink of [
    undefined,
    "ftp://example.com",
    "http://10.0.0.4/x",
  ])
    await expect(
      create({ subject: "Releases", watches: "page", sourceLink }),
    ).rejects.toThrow("Enter the page's address, starting with https://.");
  world.reader = null;
  await expect(
    create({
      subject: "Releases",
      watches: "page",
      sourceLink: "https://github.com/CopilotKit/openbot/releases",
    }),
  ).rejects.toThrow("This Bot has no web search, so it can't read a web page.");
  expect(await store.list(owner)).toEqual([]);
});

test("what it reads is worked out from the tool, never a label, and it is due at once", async () => {
  const inbox = await create({
    subject: "Your Gmail inbox",
    readWith: "mcp__gmail__list_messages",
  });
  expect(inbox).toMatchObject({ sourceKind: "app", sourceServerId: "gmail" });
  expect(inbox.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());

  const page = await create({
    subject: "OpenBot releases",
    sourceLink: "https://github.com/CopilotKit/openbot/releases",
    readWith: "mcp__parallel__web_fetch",
  });
  expect(page).toMatchObject({ sourceKind: "page", sourceServerId: null });

  const everything = await create({ subject: "Everything" });
  expect(everything).toMatchObject({
    sourceKind: "apps",
    sourceServerId: null,
  });

  // A client can't set it: the fields are the server's.
  await expect(
    create({ subject: "Sneaky", sourceKind: "page", sourceServerId: "gmail" }),
  ).rejects.toThrow();
});

test("re-accepting an offer on a page an older check-in read every app for makes it read the page", async () => {
  const link = "https://github.com/CopilotKit/openbot/releases";
  const older = await create({ subject: "Releases", sourceLink: link });
  expect(older.sourceKind).toBe("apps");
  await database
    .update(proactiveSettings)
    .set({ nextRunAt: new Date(Date.now() + 86_400_000) })
    .where(eq(proactiveSettings.id, older.id));
  const accepted = await create({
    subject: "OpenBot releases",
    sourceLink: link,
    readWith: "mcp__parallel__web_fetch",
  });
  expect(accepted.id).toBe(older.id);
  expect(accepted.sourceKind).toBe("page");
  expect(accepted.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());
});

test("a check-in on one app is offered that app's reads alone, and one on a page none", async () => {
  const inbox = await create({
    subject: "Inbox",
    readWith: "mcp__gmail__list_messages",
  });
  const everything = await create({ subject: "Everything" });
  const reads = new Map([
    ["gmail/list_messages", "Gmail"],
    ["notion/fetch", "Notion"],
  ]);
  const scope = async () => reads;
  const offered = async (setting: ProactiveSetting) => {
    let seen: string[] = [];
    const runId = randomUUID();
    const narrowed = engine.scopeForRun(proactiveInitiator(runId), scope);
    // The run's own scope is asked while its turn runs.
    const running = createProactiveEngine({
      store,
      queue: createWorkQueue(database),
      owner: `${prefix}-offered`,
      runTurn: async (input) => {
        seen = [
          ...(
            await running.scopeForRun(input.initiator, scope)(owner, bot)
          ).keys(),
        ];
        return { replyText: "" };
      },
      canUseBot: async () => true,
      readableApps: async () => [gmail, notion],
      pageReader: async () => world.reader,
      attention: { notifyAttention: async () => {} },
      catalogue: { listServers: async () => [] },
      mintThreadId: () => `${prefix}-thread-${randomUUID()}`,
    });
    // A run this process isn't running is offered nothing.
    expect([...(await narrowed(owner, bot)).keys()]).toEqual([]);
    // Only this one is due.
    await database
      .update(proactiveSettings)
      .set({ nextRunAt: new Date(Date.now() + 86_400_000) })
      .where(eq(proactiveSettings.ownerUserId, owner));
    await database
      .update(proactiveSettings)
      .set({ nextRunAt: new Date(Date.now() - 1_000) })
      .where(eq(proactiveSettings.id, setting.id));
    await running.sweep();
    return seen;
  };
  expect(await offered(inbox)).toEqual(["gmail/list_messages"]);
  expect(await offered(everything)).toEqual([
    "gmail/list_messages",
    "notion/fetch",
  ]);
  // Another initiator gets the scope as it is.
  expect([
    ...(await engine.scopeForRun(undefined, scope)(owner, bot)).keys(),
  ]).toHaveLength(2);
});

async function healthOf(setting: ProactiveSetting) {
  const [current] = (await store.list(owner)).filter(
    (row) => row.id === setting.id,
  );
  if (!current) throw new Error("No setting.");
  return (await engine.describe(owner, [current])).get(setting.id);
}

async function ran(
  setting: ProactiveSetting,
  outcomes: (
    | { outcome: "failed"; error?: string }
    | { outcome: "quiet" }
    | {
        outcome: "skipped";
        reason: ProactiveSkipReason;
      }
  )[],
) {
  // Oldest first, a second apart.
  for (const [index, run] of outcomes.entries())
    await database.insert(proactiveRuns).values({
      id: randomUUID(),
      settingId: setting.id,
      ownerUserId: owner,
      agentId: bot,
      trigger: "schedule",
      outcome: run.outcome,
      skipReason: run.outcome === "skipped" ? run.reason : null,
      error: run.outcome === "failed" ? (run.error ?? "Boom") : null,
      startedAt: new Date(Date.now() - (outcomes.length - index) * 1_000),
      finishedAt: new Date(),
    });
}

test("health: what it reads, and each way it can't look, asked afresh and cleared once fixed", async () => {
  const inbox = await create({
    subject: "Your Gmail inbox",
    readWith: "mcp__gmail__list_messages",
  });
  const everything = await create({ subject: "Everything" });
  const page = await create({
    subject: "Releases",
    watches: "page",
    sourceLink: "https://www.github.com/CopilotKit/openbot/releases",
  });
  expect(await healthOf(inbox)).toEqual({ reads: "Gmail", health: null });
  expect(await healthOf(everything)).toEqual({
    reads: "your apps",
    health: null,
  });
  expect(await healthOf(page)).toEqual({ reads: "github.com", health: null });

  world.apps = [notion];
  clock += 2 * 60_000;
  expect((await healthOf(inbox))?.health).toEqual({
    why: "Gmail isn't connected, so Inbox Bot can't check Your Gmail inbox.",
    fix: "connect",
    app: { serverId: "gmail", title: "Gmail" },
  });
  world.apps = [];
  clock += 2 * 60_000;
  expect((await healthOf(everything))?.health).toEqual({
    why: "Inbox Bot can't read any app you've connected.",
    fix: "connect",
    app: null,
  });
  world.reader = null;
  clock += 2 * 60_000;
  expect((await healthOf(page))?.health?.why).toBe(
    "Inbox Bot has no web search, so it can't read this page.",
  );
  world.usable = false;
  clock += 2 * 60_000;
  expect((await healthOf(inbox))?.health).toEqual({
    why: "This Bot is no longer available to you.",
    fix: "remove",
    app: null,
  });

  // Fixed: the row clears with no run in between, once the minute it is kept for has passed.
  world.apps = [gmail, notion];
  world.usable = true;
  clock += 2 * 60_000;
  expect((await healthOf(inbox))?.health).toBeNull();
});

test("health: three failures in a row, by what failed; a skip the person chose neither breaks nor extends one", async () => {
  const inbox = await create({
    subject: "Your Gmail inbox",
    readWith: "mcp__gmail__list_messages",
  });
  const unreached = 'unreached:["Gmail"]';
  await ran(inbox, [
    { outcome: "failed", error: unreached },
    { outcome: "skipped", reason: "paused" },
    { outcome: "failed", error: unreached },
    { outcome: "skipped", reason: "capped" },
    { outcome: "failed", error: unreached },
  ]);
  expect((await healthOf(inbox))?.health).toEqual({
    why: "Inbox Bot couldn't reach Gmail the last 3 times.",
    fix: "open",
    app: { serverId: "gmail", title: "Gmail" },
  });

  const everything = await create({ subject: "Everything" });
  await ran(everything, [
    { outcome: "failed" },
    { outcome: "failed" },
    { outcome: "failed" },
  ]);
  expect((await healthOf(everything))?.health).toEqual({
    why: "Inbox Bot couldn't finish its last 3 check-ins.",
    fix: "open",
    app: null,
  });
  // The next run that finishes clears it.
  await ran(everything, [{ outcome: "quiet" }]);
  expect((await healthOf(everything))?.health).toBeNull();

  const page = await create({
    subject: "Releases",
    watches: "page",
    sourceLink: "https://github.com/CopilotKit/openbot/releases",
  });
  await ran(page, [
    { outcome: "failed" },
    { outcome: "failed" },
    { outcome: "failed" },
  ]);
  expect((await healthOf(page))?.health?.why).toBe(
    "Inbox Bot couldn't read this page the last 3 times.",
  );

  // Paused, capped and busy alone are not can't look, and a check-in that is off says nothing.
  const quiet = await create({ subject: "Quiet" });
  await ran(quiet, [
    { outcome: "skipped", reason: "paused" },
    { outcome: "skipped", reason: "capped" },
    { outcome: "skipped", reason: "busy" },
  ]);
  expect((await healthOf(quiet))?.health).toBeNull();
  await store.update(owner, page.id, { enabled: false });
  expect((await healthOf(page))?.health).toBeNull();
});

test("readable: what New routine offers for this Bot", async () => {
  expect(await engine.readable(owner, bot)).toEqual({
    apps: ["Gmail", "Notion"],
    page: true,
  });
  world.apps = [];
  world.reader = null;
  expect(await engine.readable(owner, bot)).toEqual({ apps: [], page: false });
  world.usable = false;
  await expect(engine.readable(owner, bot)).rejects.toThrow(
    "Choose one of your Bots.",
  );
});
