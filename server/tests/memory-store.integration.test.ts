import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { personalMemories } from "../src/db/schema/memory";
import { mcpServers, mcpTools } from "../src/db/schema/plugins";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { createMemoryStore } from "../src/memory/store";
import { MemoryNotFoundError, MemoryRefusedError } from "../src/memory/types";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `memory-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const otherBot = `${prefix}-other-bot`;
const server = `${prefix}-connector`;
const ref = `${server}/read_documents`;
let vendorText =
  '[{"id":"doc1","text":"Project launch is Tuesday","title":"Roadmap"}]';
let vendorError = false;
const calls: { actorId?: string; botId?: string }[] = [];
const plugins = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async (connection) => {
    calls.push(connection);
    return { text: vendorText, isError: vendorError };
  },
});
const store = createMemoryStore(database);
const ingestion = createMemoryIngestion({ store, plugins });
beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  await database.insert(agents).values([
    { id: bot, name: "Memory Bot", type: "built_in", configuration: {} },
    {
      id: otherBot,
      name: "Other memory Bot",
      type: "remote_ag_ui",
      configuration: {},
    },
  ]);
  await database.insert(agentProfiles).values([
    {
      agentId: bot,
      ownerUserId: owner,
      title: "Memory Bot",
      roleDescription: "Assist",
      avatarSeed: bot,
      visibility: "private",
    },
    {
      agentId: otherBot,
      ownerUserId: other,
      title: "Other Bot",
      roleDescription: "Assist",
      avatarSeed: otherBot,
      visibility: "private",
    },
  ]);
  await database.insert(mcpServers).values({
    id: server,
    title: "Memory connector",
    vendor: "Fixture",
    url: "https://memory.example.test/mcp",
    provenance: "custom",
  });
  await database.insert(mcpTools).values([
    {
      serverId: server,
      name: "read_documents",
      effect: "read",
      inputSchema: {},
    },
    {
      serverId: server,
      name: "write_document",
      effect: "write",
      inputSchema: {},
    },
  ]);
  await plugins.grant("mcp", ref, bot, owner);
  await plugins.grant("mcp", `${server}/write_document`, bot, owner);
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.delete(agents).where(inArray(agents.id, [bot, otherBot]));
  await database.delete(mcpServers).where(eq(mcpServers.id, server));
  await database.$client.close();
});
async function source() {
  vendorError = false;
  vendorText =
    '[{"id":"doc1","text":"Project launch is Tuesday","title":"Roadmap"}]';
  return (
    await ingestion.createSource(owner, {
      agentId: bot,
      toolRef: ref,
      title: "Project files",
      args: {},
    })
  ).source;
}
test("facts are owner scoped on list, edit and delete", async () => {
  const fact = await store.create(owner, { content: "Private preference" });
  expect((await store.list(other)).some((row) => row.id === fact.id)).toBe(
    false,
  );
  await expect(
    store.update(other, fact.id, { content: "stolen" }),
  ).rejects.toBeInstanceOf(MemoryNotFoundError);
  await expect(store.remove(other, fact.id)).rejects.toBeInstanceOf(
    MemoryNotFoundError,
  );
});
test("manual edit and disable change the next selected context", async () => {
  const fact = await store.create(owner, { content: "Rare first fact" });
  await store.update(owner, fact.id, { content: "Rare revised fact" });
  expect(await ingestion.contextFor(owner, bot)).toContain("Rare revised fact");
  await store.update(owner, fact.id, { enabled: false });
  expect(await ingestion.contextFor(owner, bot)).not.toContain(
    "Rare revised fact",
  );
});
test("forget removes manual facts immediately", async () => {
  const fact = await store.create(owner, { content: "Forgotten unique fact" });
  await store.remove(owner, fact.id);
  expect(await ingestion.contextFor(owner, bot)).not.toContain(
    "Forgotten unique fact",
  );
});
test("opted-in connector uses actual plugin authority and execution", async () => {
  const value = await source();
  expect(calls.at(-1)?.actorId).toBe(owner);
  expect(calls.at(-1)?.botId).toBe(bot);
  expect(value.syncStatus).toBe("succeeded");
  expect(await ingestion.contextFor(owner, bot)).toContain(
    "Project launch is Tuesday",
  );
  expect(await ingestion.contextFor(other, otherBot)).not.toContain(
    "Project launch is Tuesday",
  );
});
test("changed connector content updates the same row without duplicates", async () => {
  const value = await source();
  const before = (await store.list(owner)).find(
    (row) => row.sourceId === value.id,
  );
  vendorText =
    '[{"id":"doc1","text":"Project launch moved to Friday","title":"Roadmap"}]';
  await ingestion.sync(owner, value.id);
  const rows = (await store.list(owner)).filter(
    (row) => row.sourceId === value.id,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe(before?.id);
  expect(rows[0]?.content).toContain("Friday");
});
test("disabled source is absent even while its imported facts remain stored", async () => {
  const value = await source();
  await store.setSourceEnabled(owner, value.id, false);
  expect(
    (await ingestion.recall(owner, bot)).some(
      (row) => row.sourceId === value.id,
    ),
  ).toBe(false);
});
test("deleted imported fact cannot resurrect during the next sync", async () => {
  const value = await source();
  const fact = (await store.list(owner)).find(
    (row) => row.sourceId === value.id,
  );
  if (!fact) throw new Error("Expected imported memory.");
  await store.remove(owner, fact.id);
  vendorText = '[{"id":"doc1","text":"Updated deleted fact"}]';
  await ingestion.sync(owner, value.id);
  expect((await store.list(owner)).some((row) => row.id === fact.id)).toBe(
    false,
  );
});
test("a person's edit survives later connector changes", async () => {
  const value = await source();
  const fact = (await store.list(owner)).find(
    (row) => row.sourceId === value.id,
  );
  if (!fact) throw new Error("Expected imported memory.");
  await store.update(owner, fact.id, { content: "My corrected roadmap" });
  vendorText = '[{"id":"doc1","text":"Vendor changed roadmap"}]';
  await ingestion.sync(owner, value.id);
  expect(
    (await store.list(owner)).find((row) => row.id === fact.id)?.content,
  ).toBe("My corrected roadmap");
});
test("write tools and another person's Bot cannot become ambient sources", async () => {
  await expect(
    ingestion.createSource(owner, {
      agentId: bot,
      toolRef: `${server}/write_document`,
      title: "unsafe",
      args: {},
    }),
  ).rejects.toBeInstanceOf(MemoryRefusedError);
  await expect(
    ingestion.createSource(owner, {
      agentId: otherBot,
      toolRef: ref,
      title: "stolen",
      args: {},
    }),
  ).rejects.toBeInstanceOf(MemoryRefusedError);
});
test("revoked grants immediately remove retrieval and expose source error", async () => {
  const value = await source();
  await plugins.revoke("mcp", ref, bot, owner);
  expect(
    (await ingestion.recall(owner, bot)).some(
      (row) => row.sourceId === value.id,
    ),
  ).toBe(false);
  expect((await store.getSource(owner, value.id)).syncError).toContain(
    "no longer has access",
  );
  await plugins.grant("mcp", ref, bot, owner);
});
test("vendor failure hides stale source facts and records a visible error", async () => {
  const value = await source();
  vendorError = true;
  await expect(ingestion.sync(owner, value.id)).rejects.toBeInstanceOf(
    MemoryRefusedError,
  );
  expect(
    (await ingestion.recall(owner, bot)).some(
      (row) => row.sourceId === value.id,
    ),
  ).toBe(false);
  expect((await store.getSource(owner, value.id)).syncStatus).toBe("error");
  vendorError = false;
});
test("source leases prevent competing connector calls", async () => {
  const value = await source();
  const results = await Promise.all([
    store.claimSync(owner, value.id),
    store.claimSync(owner, value.id),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  await store.failSync(owner, value.id, "Test lease released");
});
test("removing a source deletes its imported records", async () => {
  const value = await source();
  await store.removeSource(owner, value.id);
  expect(
    await database
      .select()
      .from(personalMemories)
      .where(
        and(
          eq(personalMemories.ownerUserId, owner),
          eq(personalMemories.sourceId, value.id),
        ),
      ),
  ).toHaveLength(0);
});
