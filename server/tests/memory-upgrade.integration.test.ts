import { afterAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { intelligenceCopies } from "../src/db/schema";
import { users } from "../src/db/schema/core";
import { memorySources, personalMemories } from "../src/db/schema/memory";
import {
  copyLocalMemoryToIntelligence,
  MEMORY_COPY_NAME,
  MemoryCopyMismatchError,
} from "../src/memory/upgrade";
import { testIntelligence } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { removeTestMemory, testMemoryIntelligence } from "./support/memory";

/*
 * An upgraded deployment's memory, as the previous release left it in OpenBot's own tables (and, where it
 * was entitled, mirrored in Intelligence through the runtime SDK), copied into Intelligence at boot.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const intelligence = testMemoryIntelligence();
const prefix = `memup-${randomUUID()}`;
const ada = `${prefix}-ada`;
const grace = `${prefix}-grace`;
const bot = `${prefix}-bot`;

/** A memory the previous release mirrored: written by the runtime SDK's createMemory, user scope. */
async function mirrored(userId: string, content: string): Promise<string> {
  const settings = testIntelligence();
  const response = await fetch(`${settings.apiUrl}/api/memories`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      "x-cpki-user-id": userId,
      "x-cpki-memory-grant": JSON.stringify({
        user: "read-write",
        project: "none",
      }),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      content,
      kind: "topical",
      scope: "user",
      sourceThreadIds: [],
    }),
  });
  return ((await response.json()) as { id: string }).id;
}

async function clean() {
  await database
    .delete(intelligenceCopies)
    .where(eq(intelligenceCopies.name, MEMORY_COPY_NAME));
  await database.delete(personalMemories);
  await database.delete(memorySources);
  await removeTestMemory([ada, grace]);
}

beforeEach(async () => {
  await clean();
  await database
    .insert(users)
    .values([
      { id: ada, email: `${ada}@example.test` },
      { id: grace, email: `${grace}@example.test` },
    ])
    .onConflictDoNothing();
});
afterAll(async () => {
  await clean();
  await database.delete(users).where(inArray(users.id, [ada, grace]));
  await database.$client.end();
});

test("sources and memories move with their ids, states and times; mirrored ones are adopted, not duplicated", async () => {
  const at = (iso: string) => new Date(iso);
  const sourceId = randomUUID();
  await database.insert(memorySources).values({
    id: sourceId,
    ownerUserId: ada,
    agentId: bot,
    toolRef: "docs/search_documents",
    title: "Docs: search",
    args: { query: "roadmap" },
    enabled: true,
    syncStatus: "running",
    syncError: null,
    lastSyncAt: at("2026-10-01T09:00:00Z"),
    nextSyncAt: at("2026-10-01T09:15:00Z"),
    createdAt: at("2026-09-01T09:00:00Z"),
    updatedAt: at("2026-10-01T09:00:00Z"),
  });
  // Accepted and mirrored, words in step: adopted under Intelligence's id.
  const inStep = await mirrored(ada, "Prefers morning meetings");
  // Mirrored, then edited here before the mirror caught up: copied under its own id, the mirror retired.
  const behind = await mirrored(ada, "Lives in Lisbon");
  // Two rows the mirror merged into one memory: the first adopts it, the second is copied.
  const merged = await mirrored(ada, "Drinks oolong");
  const ids = {
    person: randomUUID(),
    edited: randomUUID(),
    mergedFirst: randomUUID(),
    mergedSecond: randomUUID(),
    imported: randomUUID(),
    formed: randomUUID(),
    forgotten: randomUUID(),
    paused: randomUUID(),
    grace: randomUUID(),
  };
  await database.insert(personalMemories).values([
    {
      id: ids.person,
      ownerUserId: ada,
      content: "Prefers morning meetings",
      provenance: "You",
      reviewState: "confirmed",
      intelligenceMemoryId: inStep,
      createdAt: at("2026-09-02T09:00:00Z"),
      updatedAt: at("2026-09-02T09:00:00Z"),
    },
    {
      id: ids.edited,
      ownerUserId: ada,
      content: "Lives in Porto",
      provenance: "You",
      reviewState: "edited",
      intelligenceMemoryId: behind,
      createdAt: at("2026-09-03T09:00:00Z"),
      updatedAt: at("2026-09-04T09:00:00Z"),
    },
    {
      id: ids.mergedFirst,
      ownerUserId: ada,
      content: "Drinks oolong",
      provenance: "You",
      reviewState: "confirmed",
      intelligenceMemoryId: merged,
      createdAt: at("2026-09-05T09:00:00Z"),
      updatedAt: at("2026-09-05T09:00:00Z"),
    },
    {
      id: ids.mergedSecond,
      ownerUserId: ada,
      content: "Drinks oolong",
      provenance: "You",
      reviewState: "confirmed",
      intelligenceMemoryId: merged,
      createdAt: at("2026-09-06T09:00:00Z"),
      updatedAt: at("2026-09-06T09:00:00Z"),
    },
    {
      id: ids.imported,
      ownerUserId: ada,
      sourceId,
      externalId: "doc-1",
      importDigest: "digest-doc-1",
      content: "Launch is Tuesday",
      provenance: "Docs: search: Roadmap",
      formedBy: "import",
      reviewState: "unreviewed",
      sourceApp: "Docs: search",
      sourceRef: "docs/search_documents",
      observedAt: at("2026-10-01T09:00:00Z"),
      createdAt: at("2026-10-01T09:00:00Z"),
      updatedAt: at("2026-10-01T09:00:00Z"),
    },
    {
      id: ids.formed,
      ownerUserId: ada,
      content: "Owns the billing migration",
      provenance: "Linear, observed 2026-10-02T09:00:00.000Z",
      formedBy: "bot",
      formedByAgentId: bot,
      importDigest: "digest-billing",
      reviewState: "unreviewed",
      sourceApp: "Linear",
      sourceRef: "linear/search",
      sourceLink: "https://linear.example.test/1",
      observedAt: at("2026-10-02T09:00:00Z"),
      createdAt: at("2026-10-02T09:00:00Z"),
      updatedAt: at("2026-10-02T09:00:00Z"),
    },
    {
      id: ids.forgotten,
      ownerUserId: ada,
      content: "",
      provenance: "Linear, observed 2026-10-03T09:00:00.000Z",
      formedBy: "bot",
      formedByAgentId: bot,
      importDigest: "digest-forgotten",
      reviewState: "unreviewed",
      enabled: false,
      deletedAt: at("2026-10-04T09:00:00Z"),
      createdAt: at("2026-10-03T09:00:00Z"),
      updatedAt: at("2026-10-04T09:00:00Z"),
    },
    {
      id: ids.paused,
      ownerUserId: ada,
      content: "Plays chess",
      provenance: "You",
      reviewState: "confirmed",
      enabled: false,
      createdAt: at("2026-10-05T09:00:00Z"),
      updatedAt: at("2026-10-05T09:00:00Z"),
    },
    {
      id: ids.grace,
      ownerUserId: grace,
      content: "Grace's own",
      provenance: "You",
      reviewState: "confirmed",
      createdAt: at("2026-10-06T09:00:00Z"),
      updatedAt: at("2026-10-06T09:00:00Z"),
    },
  ]);

  // Several replicas booting at once copy it once.
  const outcomes = await Promise.all([
    copyLocalMemoryToIntelligence(database, intelligence),
    copyLocalMemoryToIntelligence(database, intelligence),
  ]);
  expect(outcomes.some((outcome) => outcome.kind === "copied")).toBe(true);
  expect(await copyLocalMemoryToIntelligence(database, intelligence)).toEqual({
    kind: "done-before",
  });

  expect(await intelligence.getSource(sourceId)).toMatchObject({
    userId: ada,
    agentId: bot,
    connectorRef: "docs/search_documents",
    title: "Docs: search",
    settings: { query: "roadmap" },
    enabled: true,
    // A sync running when the deployment stopped never finished.
    syncStatus: "idle",
    lastSyncAt: "2026-10-01T09:00:00.000Z",
    nextSyncAt: "2026-10-01T09:15:00.000Z",
    createdAt: "2026-09-01T09:00:00.000Z",
  });

  const held = new Map(
    (await intelligence.allMemories(ada, { includeInvalidated: true })).map(
      (memory) => [memory.id, memory],
    ),
  );
  // Adopted: the mirrored memory carries the row's metadata, and no second copy exists.
  expect(held.get(inStep)).toMatchObject({
    content: "Prefers morning meetings",
    formedBy: "person",
    provenance: "You",
    reviewState: "confirmed",
    invalidatedAt: null,
  });
  expect(held.has(ids.person)).toBe(false);
  // Behind: the row's words, under its own id; the old mirror retired.
  expect(held.get(ids.edited)).toMatchObject({
    content: "Lives in Porto",
    reviewState: "edited",
    createdAt: "2026-09-03T09:00:00.000Z",
    updatedAt: "2026-09-04T09:00:00.000Z",
  });
  expect(held.get(behind)?.invalidatedAt).toBeTruthy();
  // Merged: one adoption, one copy.
  expect(held.get(merged)?.invalidatedAt).toBeNull();
  expect(held.get(ids.mergedSecond)).toMatchObject({
    content: "Drinks oolong",
  });
  expect(held.get(ids.imported)).toMatchObject({
    content: "Launch is Tuesday",
    formedBy: "import",
    sourceId,
    externalId: "doc-1",
    contentDigest: "digest-doc-1",
    reviewState: "unreviewed",
    agentId: null,
    observedAt: "2026-10-01T09:00:00.000Z",
  });
  expect(held.get(ids.formed)).toMatchObject({
    formedBy: "agent",
    agentId: bot,
    contentDigest: "digest-billing",
    sourceApp: "Linear",
    sourceRef: "linear/search",
    sourceLink: "https://linear.example.test/1",
    reviewState: "unreviewed",
  });
  expect(held.get(ids.forgotten)).toMatchObject({
    content: "",
    formedBy: "agent",
    contentDigest: "digest-forgotten",
    invalidatedAt: "2026-10-04T09:00:00.000Z",
  });
  expect(held.get(ids.paused)).toMatchObject({ enabled: false });
  // The tombstone still stops the fact being formed again, by any Bot.
  const again = await intelligence.createMemory(ada, {
    content: "Forgotten fact",
    formedBy: "agent",
    agentId: `${bot}-another`,
    contentDigest: "digest-forgotten",
  });
  expect(again).toMatchObject({ id: ids.forgotten, duplicate: true });
  expect(
    (await intelligence.allMemories(grace)).map((memory) => memory.id),
  ).toEqual([ids.grace]);

  const [record] = await database
    .select()
    .from(intelligenceCopies)
    .where(eq(intelligenceCopies.name, MEMORY_COPY_NAME));
  expect(record?.copied).toBe(10);
});

test("a memory Intelligence refuses stops the boot, names it, and records nothing", async () => {
  const tooLong = randomUUID();
  await database.insert(personalMemories).values([
    {
      id: randomUUID(),
      ownerUserId: ada,
      content: "Fine",
      provenance: "You",
    },
    {
      id: tooLong,
      ownerUserId: ada,
      content: "x".repeat(9000),
      provenance: "You",
    },
  ]);
  const error = await copyLocalMemoryToIntelligence(
    database,
    intelligence,
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(MemoryCopyMismatchError);
  expect((error as Error).message).toContain(tooLong);
  expect(
    await database
      .select()
      .from(intelligenceCopies)
      .where(eq(intelligenceCopies.name, MEMORY_COPY_NAME)),
  ).toEqual([]);
});
