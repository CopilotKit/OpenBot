import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { createIntelligenceMemory } from "../src/memory/intelligence";
import { createMemoryStore } from "../src/memory/store";
import {
  MemoryRefusedError,
  MemoryUnavailableError,
} from "../src/memory/types";
import { removeBots, seedBot, testIntelligence } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { eventually, removeTestMemory, testMemory } from "./support/memory";

/*
 * A person's memory lives in Intelligence, and other apps on the same Intelligence project read it the
 * way the CopilotKit runtime does: `GET /api/memories` and `POST /api/memories/recall` with no metadata
 * filters, for the person, with a user-only grant. These tests read and write through that same door to
 * show what another app sees, and what it wrote that OpenBot shows.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `memint-${randomUUID()}`;
const ada = `${prefix}-ada`;
const grace = `${prefix}-grace`;
const bot = `${prefix}-bot`;
const otherBot = `${prefix}-other-bot`;
const { store, cache, intelligence } = testMemory(database);

/** A request as another app on the project makes it, with the runtime SDK's headers. */
async function otherApp(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  userId: string,
  body?: unknown,
  grant: { user: string; project: string } = {
    user: "read-write",
    project: "none",
  },
) {
  const settings = testIntelligence();
  const response = await fetch(`${settings.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      "x-cpki-user-id": userId,
      "x-cpki-memory-grant": JSON.stringify(grant),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}

/** What another app sees of a person's memory. */
const seenByOtherApps = async (userId: string) =>
  (
    (await otherApp("GET", "/api/memories", userId)).body as {
      memories: { content: string }[];
    }
  ).memories.map((memory) => memory.content);

/** A memory another app writes for the person, as the runtime SDK's createMemory does. */
const writtenByOtherApp = async (
  userId: string,
  content: string,
  scope: "user" | "project" = "user",
) =>
  (
    (
      await otherApp(
        "POST",
        "/api/memories",
        userId,
        { content, kind: "topical", scope, sourceThreadIds: [] },
        { user: "read-write", project: "read-write" },
      )
    ).body as { id: string }
  ).id;

beforeAll(async () => {
  await database.insert(users).values([
    { id: ada, email: `${ada}@example.test` },
    { id: grace, email: `${grace}@example.test` },
  ]);
  await seedBot({ id: bot, name: "Bot", type: "built_in" });
  await seedBot({ id: otherBot, name: "Other", type: "built_in" });
});
afterAll(async () => {
  await removeTestMemory([ada, grace]);
  await removeBots([bot, otherBot]);
  await database.delete(users).where(inArray(users.id, [ada, grace]));
  await database.$client.end();
});

test("a memory the person writes is stored in Intelligence, under that person only", async () => {
  const memory = await store.create(ada, {
    content: "Prefers morning meetings",
  });
  const held = await intelligence.allMemories(ada);
  expect(held.find((entry) => entry.id === memory.id)).toMatchObject({
    content: "Prefers morning meetings",
    formedBy: "person",
    provenance: "You",
    reviewState: "confirmed",
  });
  expect(await seenByOtherApps(ada)).toContain("Prefers morning meetings");
  expect(await intelligence.allMemories(grace)).toEqual([]);
  await store.remove(ada, memory.id);
});

test("an edit reaches other apps, and pausing or forgetting takes it from them", async () => {
  const memory = await store.create(ada, { content: "Lives in Lisbon" });
  const edited = await store.update(ada, memory.id, {
    content: "Lives in Porto",
  });
  const seen = await seenByOtherApps(ada);
  expect(seen).toContain("Lives in Porto");
  expect(seen).not.toContain("Lives in Lisbon");

  await store.update(ada, edited.id, { enabled: false });
  expect(await seenByOtherApps(ada)).not.toContain("Lives in Porto");

  await store.update(ada, edited.id, { enabled: true });
  expect(await seenByOtherApps(ada)).toContain("Lives in Porto");

  await store.remove(ada, edited.id);
  expect(await seenByOtherApps(ada)).not.toContain("Lives in Porto");
});

test("a Bot-formed memory reaches no other reader, and once confirmed only its own Bot's recall", async () => {
  const formed = await store.formMemory(ada, {
    agentId: bot,
    content: "Owns the billing migration",
    sourceApp: "Linear",
  });
  expect(await seenByOtherApps(ada)).not.toContain(
    "Owns the billing migration",
  );
  await store.update(ada, formed.id, { reviewState: "confirmed" });
  // Scoped to the Bot that formed it: Intelligence recalls it for that Bot, never for anyone else.
  const forBot = await intelligence.recall(ada, "billing", {
    limit: 5,
    agentId: bot,
  });
  expect(forBot.memories.map((memory) => memory.id)).toEqual([formed.id]);
  const forAnyone = await intelligence.recall(ada, "billing", { limit: 5 });
  expect(forAnyone.memories).toEqual([]);
  expect(await seenByOtherApps(ada)).not.toContain(
    "Owns the billing migration",
  );
  await store.remove(ada, formed.id);
});

test("without semantic memory, memory is stored and a search is the word match it always was", async () => {
  const memory = await store.create(ada, { content: "Allergic to peanuts" });
  expect((await store.list(ada)).map((m) => m.content)).toContain(
    "Allergic to peanuts",
  );
  const recalled = await store.retrieve(ada, [], "peanuts");
  expect(recalled.map((m) => m.content)).toEqual(["Allergic to peanuts"]);
  // This Intelligence has no embedder, so it says it recalls by keyword.
  expect((await intelligence.recall(ada, "peanuts", { limit: 5 })).mode).toBe(
    "keyword",
  );
  await store.remove(ada, memory.id);
});

test("Intelligence unreachable: a person's memory already held still answers each turn; a write says try again", async () => {
  const memory = await store.create(ada, { content: "Reports to Grace" });
  expect((await store.list(ada)).map((m) => m.content)).toContain(
    "Reports to Grace",
  );
  // The same instance's copy, with Intelligence gone from under it.
  const down = createMemoryStore(database, {
    intelligence: createIntelligenceMemory({
      apiUrl: "http://127.0.0.1:1",
      apiKey: testIntelligence().apiKey,
    }),
    cache,
  });
  expect((await down.retrieve(ada, [], "")).map((m) => m.content)).toContain(
    "Reports to Grace",
  );
  await expect(
    down.create(ada, { content: "Started in March" }),
  ).rejects.toBeInstanceOf(MemoryUnavailableError);
  await expect(
    down.update(ada, memory.id, { content: "Reports to Ada" }),
  ).rejects.toBeInstanceOf(MemoryUnavailableError);
  await store.remove(ada, memory.id);
});

test("another person's Intelligence memories never reach this person, nor do project-wide ones", async () => {
  await writtenByOtherApp(grace, "Grace's private fact");
  const shared = await writtenByOtherApp(
    grace,
    "Shared across the project",
    "project",
  );
  const own = await writtenByOtherApp(ada, "Ada likes tea");
  cache.forget(ada);
  const listed = await store.list(ada);
  expect(listed.map((m) => m.content)).toEqual(["Ada likes tea"]);
  expect(listed[0]?.id).toBe(own);
  expect(listed[0]?.formedBy).toBe("intelligence");
  const recalled = await store.retrieve(ada, [], "fact");
  expect(recalled).toEqual([]);
  await store.remove(ada, own);
  await otherApp(
    "DELETE",
    `/api/memories/${shared}?purge=true`,
    grace,
    undefined,
    { user: "read-write", project: "read-write" },
  );
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
  await store.remove(ada, formed.id);
});

test("a memory another app wrote is the person's own: recalled, edited and forgotten here", async () => {
  await writtenByOtherApp(ada, "Uses vim keybindings");
  cache.forget(ada);
  const context = await store.retrieve(ada, [], "");
  expect(context.map((m) => m.content)).toContain("Uses vim keybindings");
  const written = context.find((m) => m.content === "Uses vim keybindings");
  // An id from before this release, prefixed, still reaches it.
  const edited = await store.update(ada, `intelligence:${written?.id}`, {
    content: "Uses emacs keybindings",
  });
  expect(edited.formedBy).toBe("intelligence");
  const seen = await seenByOtherApps(ada);
  expect(seen).toContain("Uses emacs keybindings");
  expect(seen).not.toContain("Uses vim keybindings");
  await expect(
    store.update(ada, edited.id, { enabled: false }),
  ).rejects.toBeInstanceOf(MemoryRefusedError);
  await store.remove(ada, edited.id);
  expect(await seenByOtherApps(ada)).not.toContain("Uses emacs keybindings");
});

test("a memory OpenBot formed is forgotten as a tombstone, kept so it is not formed again", async () => {
  const formed = await store.formMemory(ada, {
    agentId: bot,
    content: "Has a dog named Biscuit",
    sourceApp: "Photos",
  });
  await store.remove(ada, formed.id);
  const tombstone = (
    await intelligence.allMemories(ada, { includeInvalidated: true })
  ).find((memory) => memory.id === formed.id);
  expect(tombstone).toMatchObject({ content: "", formedBy: "agent" });
  expect(tombstone?.invalidatedAt).toBeTruthy();
  expect(
    await store.formMemory(ada, {
      agentId: otherBot,
      content: "Has a dog named Biscuit",
      sourceApp: "Photos",
    }),
  ).toEqual({ id: formed.id, duplicate: true, forgotten: true });
});

test("a change made on another instance reaches this one's copy by the change feed", async () => {
  const here = testMemory(database, { changes: true });
  const there = testMemory(database, { changes: true });
  try {
    await eventually(
      () => here.cache.subscribed() && there.cache.subscribed(),
      "both instances joined",
    );
    const memory = await there.store.create(ada, {
      content: "Prefers the window seat",
    });
    // This instance holds Ada's memory before the change.
    expect(
      (await here.store.retrieve(ada, [], "")).map((m) => m.content),
    ).toContain("Prefers the window seat");
    await there.store.update(ada, memory.id, { enabled: false });
    await eventually(
      async () =>
        !(await here.store.retrieve(ada, [], ""))
          .map((m) => m.content)
          .includes("Prefers the window seat"),
      "the pause to reach the other instance",
    );
    await there.store.remove(ada, memory.id);
  } finally {
    here.cache.stop();
    there.cache.stop();
  }
});

test("a Bot deleted for good takes its memory sources and the memories it formed, for everyone", async () => {
  const gone = `${prefix}-purged-bot`;
  const source = await store.createSource(ada, {
    agentId: gone,
    toolRef: "docs/search",
    title: "Docs",
    args: {},
  });
  await intelligence.importRecords(ada, source.id, [
    {
      externalId: "1",
      content: "Imported for the gone Bot",
      contentDigest: "g1",
    },
  ]);
  await store.formMemory(grace, {
    agentId: gone,
    content: "Formed by the gone Bot",
    sourceApp: "Docs",
  });
  const own = await store.create(ada, { content: "Ada's own, kept" });
  await store.forgetBot(gone);
  expect(await intelligence.sources({ agentId: gone })).toEqual([]);
  const left = [
    ...(await intelligence.allMemories(ada, { includeInvalidated: true })),
    ...(await intelligence.allMemories(grace, { includeInvalidated: true })),
  ].map((memory) => memory.content);
  expect(left).not.toContain("Imported for the gone Bot");
  expect(left).not.toContain("Formed by the gone Bot");
  expect(left).toContain("Ada's own, kept");
  await store.remove(ada, own.id);
});

test("removing a person takes every memory and source of theirs, and no one else's", async () => {
  const leaving = `${prefix}-leaving`;
  await store.createSource(leaving, {
    agentId: bot,
    toolRef: "docs/search",
    title: "Docs",
    args: {},
  });
  await store.create(leaving, { content: "Leaving soon" });
  const stays = await store.create(ada, { content: "Ada stays" });
  await store.forgetPerson(leaving);
  expect(
    await intelligence.allMemories(leaving, { includeInvalidated: true }),
  ).toEqual([]);
  expect(await intelligence.sources({ userId: leaving })).toEqual([]);
  expect((await store.list(ada)).map((memory) => memory.id)).toContain(
    stays.id,
  );
  await store.remove(ada, stays.id);
});
