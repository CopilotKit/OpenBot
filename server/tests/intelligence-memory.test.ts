import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createMemoryCache } from "../src/memory/cache";
import { MemoryIntelligenceError } from "../src/memory/intelligence";
import { testIntelligence } from "./support/bots";
import { removeTestMemory, testMemoryIntelligence } from "./support/memory";

// The memory client and this instance's copy, against the real Intelligence (support/memory.ts).

const person = `intmem-${randomUUID()}`;
const intelligence = testMemoryIntelligence();
afterAll(() => removeTestMemory([person]));

test("project-scoped memories never reach a person: the client asks for their own only", async () => {
  const settings = testIntelligence();
  // Another app on the project writes a memory for everyone.
  const shared = await fetch(`${settings.apiUrl}/api/memories`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      "x-cpki-user-id": person,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      content: `Project-wide ${person}`,
      kind: "topical",
      scope: "project",
    }),
  });
  expect(shared.status).toBe(201);
  const sharedId = ((await shared.json()) as { id: string }).id;
  try {
    const own = await intelligence.createMemory(person, {
      content: "Mine alone",
    });
    const listed = await intelligence.allMemories(person);
    expect(listed.map((memory) => memory.id)).toEqual([own.id]);
    expect(
      (await intelligence.recall(person, "project", { limit: 5 })).memories,
    ).toEqual([]);
  } finally {
    await fetch(`${settings.apiUrl}/api/memories/${sharedId}?purge=true`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        "x-cpki-user-id": person,
      },
    });
  }
});

test("storage needs no semantic memory: store, list, recall by keyword, forget", async () => {
  const memory = await intelligence.createMemory(person, {
    content: "Plays the cello on Sundays",
    formedBy: "person",
  });
  expect(memory).toMatchObject({ scope: "user", kind: "topical", version: 1 });
  const recalled = await intelligence.recall(person, "cello", { limit: 5 });
  expect(recalled.mode).toBe("keyword");
  expect(recalled.memories.map((entry) => entry.id)).toEqual([memory.id]);
  expect(await intelligence.forgetMemory(person, memory.id)).toBe(true);
  expect(await intelligence.forgetMemory(person, memory.id)).toBe(false);
});

test("a refusal is an error carrying Intelligence's code", async () => {
  const error = await intelligence
    .createMemory(person, { content: "x", sourceId: "no-such-source" })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(MemoryIntelligenceError);
  expect(error).toMatchObject({
    status: 404,
    code: "MEMORY_SOURCE_NOT_FOUND",
  });
  // A source changed since it was read is said so, not thrown.
  const source = await intelligence.createSource({
    userId: person,
    agentId: "bot",
    connectorRef: "docs/search",
    title: "Docs",
  });
  expect(
    await intelligence.updateSource(source.id, { enabled: false }, 1),
  ).toMatchObject({ version: 2 });
  expect(await intelligence.updateSource(source.id, { enabled: true }, 1)).toBe(
    "stale",
  );
  expect(await intelligence.deleteSource(source.id)).toBe(true);
});

test("changing a memory that is already retired says so", async () => {
  const memory = await intelligence.createMemory(person, {
    content: "Drives a blue car",
  });
  const changed = await intelligence.updateMemory(person, memory.id, {
    content: "Drives a red car",
  });
  expect(changed?.retiredId).toBe(memory.id);
  expect(
    await intelligence.updateMemory(person, memory.id, {
      content: "Drives a green car",
    }),
  ).toBeNull();
  // The retired memory names the one it became.
  expect(await intelligence.getMemory(person, memory.id)).toMatchObject({
    supersededBy: changed?.id,
  });
});

test("a person's memory is read once and served from this instance's copy; a write shows at once", async () => {
  let reads = 0;
  const cache = createMemoryCache({
    intelligence: {
      allMemories: (userId) => {
        reads += 1;
        return intelligence.allMemories(userId);
      },
      sources: (filter) => intelligence.sources(filter),
    },
  });
  await cache.get(person);
  await cache.get(person);
  expect(reads).toBe(1);
  const memory = await intelligence.createMemory(person, {
    content: "Written here",
  });
  cache.putMemory(person, memory);
  expect(
    (await cache.get(person)).memories.map((entry) => entry.content),
  ).toContain("Written here");
  expect(reads).toBe(1);
  // An announcement for a version this instance already holds is its own write coming back.
  cache.onChange({
    entity: "memory",
    userId: person,
    id: memory.id,
    version: 1,
    change: "created",
  });
  await cache.get(person);
  expect(reads).toBe(1);
  // Somebody else's change is read again on the next use.
  cache.onChange({
    entity: "memory",
    userId: person,
    id: memory.id,
    version: 2,
    change: "updated",
  });
  await cache.get(person);
  expect(reads).toBe(2);
});
