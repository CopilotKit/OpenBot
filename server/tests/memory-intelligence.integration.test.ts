import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { personalMemories } from "../src/db/schema/memory";
import {
  createIntelligenceMemory,
  type IntelligenceMemoryClient,
} from "../src/memory/intelligence";
import { createMemoryStore } from "../src/memory/store";
import {
  MemoryNotFoundError,
  MemoryRefusedError,
  MemoryUnavailableError,
} from "../src/memory/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A stand-in for CopilotKit Intelligence memory: memories per user, retired rather than deleted,
 * project-scoped rows that must never reach a person, and switches for "not entitled" and
 * "unreachable". Every call is recorded so a test can assert who was asked about what.
 */
function fakeIntelligence() {
  type Row = {
    id: string;
    userId: string;
    scope: "user" | "project";
    content: string;
    invalidatedAt: string | null;
  };
  const rows: Row[] = [];
  const calls: { method: string; userId?: string; grant?: unknown }[] = [];
  const state = { entitled: true, down: false };
  let next = 1;
  const fail = (status: number) =>
    Object.assign(new Error(`HTTP ${status}`), { status });
  const guard = () => {
    if (state.down) throw new TypeError("fetch failed");
    if (!state.entitled) throw fail(403);
  };
  const summary = (row: Row) => ({
    id: row.id,
    kind: "topical",
    scope: row.scope,
    content: row.content,
    sourceThreadIds: [],
    invalidatedAt: row.invalidatedAt,
  });
  const client = {
    async getRuntimeEntitlements() {
      calls.push({ method: "getRuntimeEntitlements" });
      if (state.down) throw new TypeError("fetch failed");
      return {
        status: "ready",
        entitlement: {
          active: true,
          source: "managedOrgSubscription",
          features: { memory: state.entitled },
          limits: {},
        },
      };
    },
    async listMemories(params: { userId: string; memoryGrant?: unknown }) {
      calls.push({
        method: "listMemories",
        userId: params.userId,
        grant: params.memoryGrant,
      });
      guard();
      // A platform that ignored the grant: project rows come back too, and must be filtered out.
      return {
        memories: rows
          .filter(
            (row) =>
              !row.invalidatedAt &&
              (row.userId === params.userId || row.scope === "project"),
          )
          .map(summary),
      };
    },
    async recallMemories(params: {
      userId: string;
      query: string;
      memoryGrant?: unknown;
    }) {
      calls.push({
        method: "recallMemories",
        userId: params.userId,
        grant: params.memoryGrant,
      });
      guard();
      return {
        memories: rows
          .filter(
            (row) =>
              !row.invalidatedAt &&
              (row.userId === params.userId || row.scope === "project") &&
              row.content.toLowerCase().includes(params.query.toLowerCase()),
          )
          .map((row) => ({ ...summary(row), score: 0.9 })),
      };
    },
    async createMemory(params: {
      userId: string;
      content: string;
      memoryGrant?: unknown;
    }) {
      calls.push({
        method: "createMemory",
        userId: params.userId,
        grant: params.memoryGrant,
      });
      guard();
      const row: Row = {
        id: `int-${next++}`,
        userId: params.userId,
        scope: "user",
        content: params.content,
        invalidatedAt: null,
      };
      rows.push(row);
      return { ...summary(row), absorbed: false };
    },
    async updateMemory(params: {
      userId: string;
      id: string;
      content: string;
      memoryGrant?: unknown;
    }) {
      calls.push({ method: "updateMemory", userId: params.userId });
      guard();
      const old = rows.find(
        (row) =>
          row.id === params.id &&
          row.userId === params.userId &&
          !row.invalidatedAt,
      );
      if (!old) throw fail(404);
      old.invalidatedAt = new Date().toISOString();
      const row: Row = {
        id: `int-${next++}`,
        userId: params.userId,
        scope: "user",
        content: params.content,
        invalidatedAt: null,
      };
      rows.push(row);
      return { ...summary(row), retiredId: old.id };
    },
    async removeMemory(params: { userId: string; id: string }) {
      calls.push({ method: "removeMemory", userId: params.userId });
      guard();
      const row = rows.find(
        (candidate) =>
          candidate.id === params.id &&
          candidate.userId === params.userId &&
          !candidate.invalidatedAt,
      );
      if (!row) throw fail(404);
      row.invalidatedAt = new Date().toISOString();
    },
  };
  const live = (userId: string) =>
    rows.filter((row) => row.userId === userId && !row.invalidatedAt);
  const seed = (
    userId: string,
    content: string,
    scope: Row["scope"] = "user",
  ) => {
    const row: Row = {
      id: `int-${next++}`,
      userId,
      scope,
      content,
      invalidatedAt: null,
    };
    rows.push(row);
    return row.id;
  };
  return {
    client: client as unknown as IntelligenceMemoryClient,
    calls,
    state,
    live,
    seed,
  };
}

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `memint-${randomUUID()}`;
const ada = `${prefix}-ada`;
const grace = `${prefix}-grace`;
const bot = `${prefix}-bot`;
const otherBot = `${prefix}-other-bot`;

let fake: ReturnType<typeof fakeIntelligence>;
let clock = 1_000_000;
let store: ReturnType<typeof createMemoryStore>;

beforeAll(async () => {
  await database.insert(users).values([
    { id: ada, email: `${ada}@example.test` },
    { id: grace, email: `${grace}@example.test` },
  ]);
  await database.insert(agents).values([
    { id: bot, name: "Bot", type: "built_in", configuration: {} },
    { id: otherBot, name: "Other", type: "built_in", configuration: {} },
  ]);
});
beforeEach(async () => {
  await database
    .delete(personalMemories)
    .where(inArray(personalMemories.ownerUserId, [ada, grace]));
  fake = fakeIntelligence();
  clock += 10 * 60_000 + 1;
  store = createMemoryStore(database, {
    intelligence: createIntelligenceMemory({
      client: fake.client,
      now: () => clock,
      log: () => {},
    }),
  });
});
afterAll(async () => {
  await database
    .delete(personalMemories)
    .where(inArray(personalMemories.ownerUserId, [ada, grace]));
  await database.delete(agents).where(inArray(agents.id, [bot, otherBot]));
  await database.delete(users).where(inArray(users.id, [ada, grace]));
  await database.$client.end();
});

const rowOf = async (id: string) =>
  (
    await database
      .select()
      .from(personalMemories)
      .where(eq(personalMemories.id, id))
  )[0];

test("a memory the person writes is stored in Intelligence, under that person only", async () => {
  const memory = await store.create(ada, {
    content: "Prefers morning meetings",
  });
  const row = await rowOf(memory.id);
  expect(row?.intelligenceMemoryId).toBeTruthy();
  expect(fake.live(ada).map((m) => m.content)).toEqual([
    "Prefers morning meetings",
  ]);
  expect(fake.live(grace)).toEqual([]);
  const writes = fake.calls.filter((call) => call.method === "createMemory");
  expect(writes.every((call) => call.userId === ada)).toBe(true);
  expect(writes[0]?.grant).toEqual({ user: "read-write", project: "none" });
});

test("an edit supersedes the Intelligence copy, and pausing or forgetting retires it", async () => {
  const memory = await store.create(ada, { content: "Lives in Lisbon" });
  const first = (await rowOf(memory.id))?.intelligenceMemoryId;
  await store.update(ada, memory.id, { content: "Lives in Porto" });
  const edited = await rowOf(memory.id);
  expect(edited?.intelligenceMemoryId).not.toBe(first);
  expect(fake.live(ada).map((m) => m.content)).toEqual(["Lives in Porto"]);

  await store.update(ada, memory.id, { enabled: false });
  expect(fake.live(ada)).toEqual([]);
  expect((await rowOf(memory.id))?.intelligenceMemoryId).toBeNull();

  await store.update(ada, memory.id, { enabled: true });
  expect(fake.live(ada).map((m) => m.content)).toEqual(["Lives in Porto"]);

  await store.remove(ada, memory.id);
  expect(fake.live(ada)).toEqual([]);
});

test("a Bot-formed memory reaches Intelligence only once the person confirms it", async () => {
  const formed = await store.formMemory(ada, {
    agentId: bot,
    content: "Owns the billing migration",
    sourceApp: "Linear",
  });
  expect(fake.live(ada)).toEqual([]);
  await store.update(ada, formed.id, { reviewState: "confirmed" });
  expect(fake.live(ada).map((m) => m.content)).toEqual([
    "Owns the billing migration",
  ]);
});

test("not entitled: nothing is sent, the tables are the whole store, and nothing fails", async () => {
  fake.state.entitled = false;
  const memory = await store.create(ada, { content: "Allergic to peanuts" });
  expect((await rowOf(memory.id))?.intelligenceMemoryId).toBeNull();
  expect(fake.calls.some((call) => call.method === "createMemory")).toBe(false);
  expect((await store.list(ada)).map((m) => m.content)).toEqual([
    "Allergic to peanuts",
  ]);
  const recalled = await store.retrieve(ada, [], "peanuts");
  expect(recalled.map((m) => m.content)).toEqual(["Allergic to peanuts"]);
});

test("unreachable: writes stay local and the next pass backfills them once, without duplicates", async () => {
  fake.state.down = true;
  const memory = await store.create(ada, { content: "Reports to Grace" });
  expect((await rowOf(memory.id))?.intelligenceMemoryId).toBeNull();
  expect((await store.list(ada)).map((m) => m.content)).toEqual([
    "Reports to Grace",
  ]);

  fake.state.down = false;
  clock += 61_000;
  expect(await store.mirrorPending()).toBeGreaterThan(0);
  expect(fake.live(ada).map((m) => m.content)).toEqual(["Reports to Grace"]);
  await store.mirrorPending();
  expect(fake.live(ada)).toHaveLength(1);
});

test("another person's Intelligence memories never reach this person, nor do project-wide ones", async () => {
  fake.seed(grace, "Grace's private fact");
  fake.seed(grace, "Shared across the project", "project");
  const own = fake.seed(ada, "Ada likes tea");
  const listed = await store.list(ada);
  expect(listed.map((m) => m.content)).toEqual(["Ada likes tea"]);
  expect(listed[0]?.id).toBe(`intelligence:${own}`);
  expect(listed[0]?.formedBy).toBe("intelligence");
  const recalled = await store.retrieve(ada, [], "fact");
  expect(recalled).toEqual([]);
  expect(
    fake.calls
      .filter((call) => call.userId !== undefined)
      .every((call) => call.userId === ada),
  ).toBe(true);
});

test("recall keeps a Bot-formed memory to the Bot that formed it", async () => {
  const formed = await store.formMemory(ada, {
    agentId: bot,
    content: "Deploy window is Thursday",
    sourceApp: "Calendar",
  });
  await store.update(ada, formed.id, { reviewState: "confirmed" });
  const forBot = await store.retrieve(ada, [], "deploy", {
    botId: bot,
    heldServerIds: new Set(),
  });
  expect(forBot.map((m) => m.id)).toEqual([formed.id]);
  const forOther = await store.retrieve(ada, [], "deploy", {
    botId: otherBot,
    heldServerIds: new Set(),
  });
  expect(forOther).toEqual([]);
});

test("a memory only Intelligence holds is the person's own: recalled, edited and forgotten here", async () => {
  const id = fake.seed(ada, "Uses vim keybindings");
  const context = await store.retrieve(ada, [], "");
  expect(context.map((m) => m.content)).toContain("Uses vim keybindings");
  const edited = await store.update(ada, `intelligence:${id}`, {
    content: "Uses emacs keybindings",
  });
  expect(fake.live(ada).map((m) => m.content)).toEqual([
    "Uses emacs keybindings",
  ]);
  await expect(
    store.update(ada, edited.id, { enabled: false }),
  ).rejects.toBeInstanceOf(MemoryRefusedError);
  await store.remove(ada, edited.id);
  expect(fake.live(ada)).toEqual([]);
});

test("a memory OpenBot describes cannot be forgotten through its Intelligence id", async () => {
  const memory = await store.create(ada, { content: "Has a dog" });
  const linked = (await rowOf(memory.id))?.intelligenceMemoryId;
  await expect(
    store.remove(ada, `intelligence:${linked}`),
  ).rejects.toBeInstanceOf(MemoryNotFoundError);
  expect(fake.live(ada)).toHaveLength(1);
});

test("editing an Intelligence-only memory while Intelligence is down answers unavailable, not a crash", async () => {
  const id = fake.seed(ada, "Speaks Portuguese");
  fake.state.down = true;
  clock += 10 * 60_000 + 1;
  await expect(
    store.update(ada, `intelligence:${id}`, { content: "Speaks Spanish" }),
  ).rejects.toBeInstanceOf(MemoryUnavailableError);
});
