import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import {
  createBotConfiguration,
  installBotConfiguration,
} from "../src/configuration/directory";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { mcpTools } from "../src/db/schema/plugins";
import { proactiveSettings } from "../src/db/schema/proactive";
import {
  createMemoryDefaults,
  DEFAULT_RESEARCH_INTERVAL_MINUTES,
  lockDefaults,
} from "../src/memory/defaults";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { createPluginStore } from "../src/plugins/store";
import { createProactiveStore } from "../src/proactive/store";
import { removeTestMemory, testMemory } from "./support/memory";
import {
  clearPreferences,
  removeBots,
  seedBot,
  storedPreferences,
  useTestConfiguration,
} from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  removeConnectionsWhere,
  removeServers,
  seedBrokered,
  seedServer,
  useTestVault,
} from "./support/vault";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `defaults-owner-${suite}`;
const other = `defaults-other-${suite}`;
const bot = `defaults-bot-${suite}`;
const secondBot = `defaults-second-${suite}`;
const app = `linear-${suite}`;
const unconnected = `notes-${suite}`;
// Apps, connections and credentials live in Intelligence: the process's vault directory, before the store.
const directory = await useTestVault();
const plugins = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(directory),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  // This suite's apps are `composio://` rows with `provenance: "composio"`, and the store has no
  // default for this: it dispatches the toolkit read on it, so the fixtures name their own broker.
  brokerProvider: "composio",
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async () => ({ text: "[]", isError: false }),
});
const { store: memory, intelligence, cache } = testMemory(database);
const ingestion = createMemoryIngestion({ store: memory, plugins });
const proactive = createProactiveStore(database);
const synced: string[] = [];

function defaults(
  overrides: Partial<Parameters<typeof createMemoryDefaults>[0]> = {},
) {
  return createMemoryDefaults({
    database,
    memory,
    // The vendor read is the ingestion's own business; here only that it was asked for.
    ingestion: {
      defaultSourceCandidates: ingestion.defaultSourceCandidates,
      sync: async (_owner, id) => {
        synced.push(id);
        return undefined as never;
      },
    },
    sources: true,
    research: true,
    channelBots: async () => [bot],
    canDeliver: async (person) => person === owner,
    mintThreadId: () => `thread-${randomUUID()}`,
    minIntervalMs: 0,
    log: () => {},
    ...overrides,
  });
}

/** The person's sources for a Bot, as Intelligence holds them. */
const sourcesOf = (person: string, agentId: string) =>
  memory.sourcesFor(person, agentId);
const researchOf = (person: string, agentId: string) =>
  database
    .select()
    .from(proactiveSettings)
    .where(
      and(
        eq(proactiveSettings.ownerUserId, person),
        eq(proactiveSettings.agentId, agentId),
      ),
    );
async function reset() {
  for (const person of [owner, other])
    await intelligence.purgeSources({ userId: person });
  cache.forget();
  await database
    .delete(proactiveSettings)
    .where(inArray(proactiveSettings.ownerUserId, [owner, other]));
  await clearPreferences([owner, other]);
}

beforeAll(async () => {
  await useTestConfiguration();
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  for (const id of [bot, secondBot])
    await seedBot({
      id,
      name: id,
      type: "built_in",
      ownerUserId: owner,
      title: id,
      roleDescription: "Assist",
    });
  await seedServer({
    id: app,
    title: "Linear",
    vendor: "Composio",
    url: `composio://${app}`,
    provenance: "composio",
    authScheme: "OAUTH2",
    accountMode: "personal",
  });
  await seedServer({
    id: unconnected,
    title: "Notes",
    vendor: "Composio",
    url: `composio://${unconnected}`,
    provenance: "composio",
    authScheme: "OAUTH2",
    accountMode: "personal",
  });
  await database.insert(mcpTools).values([
    // A lookup that needs an argument, the app's own bookkeeping, a write, and the person's records.
    {
      serverId: app,
      name: "LINEAR_GET_ISSUE",
      vendorName: "LINEAR_GET_ISSUE",
      effect: "read",
      inputSchema: { type: "object", required: ["id"] },
    },
    {
      serverId: app,
      name: "LINEAR_LIST_LABELS",
      vendorName: "LINEAR_LIST_LABELS",
      effect: "read",
      inputSchema: { type: "object" },
    },
    {
      serverId: app,
      name: "LINEAR_CREATE_ISSUE",
      vendorName: "LINEAR_CREATE_ISSUE",
      effect: "write",
      inputSchema: { type: "object" },
    },
    {
      serverId: app,
      name: "LINEAR_LIST_ISSUES",
      vendorName: "LINEAR_LIST_ISSUES",
      effect: "read",
      inputSchema: { type: "object" },
    },
    {
      serverId: unconnected,
      name: "NOTES_LIST",
      vendorName: "NOTES_LIST",
      effect: "read",
      inputSchema: { type: "object" },
    },
  ]);
  for (const agentId of [bot, secondBot])
    for (const ref of [
      `${app}/LINEAR_GET_ISSUE`,
      `${app}/LINEAR_LIST_LABELS`,
      `${app}/LINEAR_CREATE_ISSUE`,
      `${app}/LINEAR_LIST_ISSUES`,
      `${unconnected}/NOTES_LIST`,
    ])
      await plugins.grant("mcp", ref, agentId, owner);
  // The owner connected Linear in their own account; nobody connected Notes.
  await seedBrokered({
    provider: "composio",
    app,
    holder: "person",
    userId: owner,
    vendorUserId: owner,
  });
});
afterAll(async () => {
  await removeTestMemory([owner, other]);
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await removeBots([bot, secondBot]);
  await removeServers([app, unconnected]);
  await removeConnectionsWhere(
    (connection) => connection.userId === owner || connection.userId === other,
  );
  await database.$client.close();
});

describe("memory sources, on by default", () => {
  test("a fresh person gets one source per app they connected, reading their records as them", async () => {
    await reset();
    synced.length = 0;
    const created = await defaults().adoptSources(owner, bot);
    expect(created).toHaveLength(1);
    const [source] = await sourcesOf(owner, bot);
    expect(source).toMatchObject({
      id: created[0],
      ownerUserId: owner,
      agentId: bot,
      toolRef: `${app}/LINEAR_LIST_ISSUES`,
      title: "Linear: LINEAR_LIST_ISSUES",
      args: {},
      enabled: true,
    });
    // Read right away, not on the next sweep.
    expect(synced).toEqual(created);
    // Again: still one.
    expect(await defaults().adoptSources(owner, bot)).toEqual([]);
    expect(await sourcesOf(owner, bot)).toHaveLength(1);
  });

  test("while a removal holds the person's lock for that Bot, adoption steps aside rather than wait", async () => {
    await reset();
    // Its own connection, as another request's transaction would be.
    const removal = createDatabase(testDatabaseUrl(), { max: 1 });
    try {
      await removal.transaction(async (transaction) => {
        await lockDefaults(transaction, owner, bot);
        expect(await defaults().adoptSources(owner, bot)).toEqual([]);
        expect(
          await defaults().adoptResearch(owner, bot, `channel-${suite}`),
        ).toBe(false);
      });
    } finally {
      await removal.$client.close();
    }
    expect(await sourcesOf(owner, bot)).toEqual([]);
    expect(await defaults().adoptSources(owner, bot)).toHaveLength(1);
  });

  test("nobody else's Bot and no app the person did not connect", async () => {
    await reset();
    expect(await defaults().adoptSources(other, bot)).toEqual([]);
    expect(await sourcesOf(other, bot)).toEqual([]);
    await defaults().adoptSources(owner, bot);
    expect(
      (await sourcesOf(owner, bot)).map((row) => row.toolRef.split("/")[0]),
    ).toEqual([app]);
  });

  test("a source the person turned off stays off", async () => {
    await reset();
    const [id] = await defaults().adoptSources(owner, bot);
    await memory.setSourceEnabled(owner, id as string, false);
    expect(await defaults().adoptSources(owner, bot)).toEqual([]);
    expect(await sourcesOf(owner, bot)).toMatchObject([{ id, enabled: false }]);
  });

  test("a source the person removed is never added back, for that Bot only", async () => {
    await reset();
    const [id] = await defaults().adoptSources(owner, bot);
    await memory.removeSource(owner, id as string);
    expect(await defaults().adoptSources(owner, bot)).toEqual([]);
    expect(await sourcesOf(owner, bot)).toEqual([]);
    expect(
      (await storedPreferences(owner)).optOuts.map((optOut) => ({
        feature: optOut.feature,
        scope: optOut.scope,
      })),
    ).toEqual([{ feature: "memory_source", scope: app }]);
    // The person's other Bot is a separate choice.
    expect(await defaults().adoptSources(owner, secondBot)).toHaveLength(1);
  });

  /*
   * The opt-out is in Intelligence and each replica holds a copy. A removal on one replica writes the
   * opt-out there before it deletes the row; another replica that has not heard of it yet would
   * adopt the app straight back from its stale copy. So an adoption that created something asks
   * Intelligence afresh and takes back what an opt-out now covers.
   */
  test("an opt-out another replica wrote a moment ago wins, though this replica has not heard of it", async () => {
    await reset();
    const heard = await useTestConfiguration();
    // A replica whose copy predates the opt-out: no announcements reach it, no timer re-reads it.
    const deaf = createBotConfiguration({
      client: heard.client,
      registry: {
        subscribe: async () => {
          throw new Error("This replica hears nothing.");
        },
      },
      resyncIntervalMs: 3_600_000,
    });
    await deaf.start();
    await heard.client.preferences.change(
      owner,
      [{ op: "optOut", botId: bot, feature: "memory_source", scope: app }],
      `test:${randomUUID()}`,
    );
    installBotConfiguration(deaf);
    try {
      expect(await defaults().adoptSources(owner, bot)).toEqual([]);
      expect(await sourcesOf(owner, bot)).toEqual([]);
    } finally {
      deaf.stop();
      installBotConfiguration(heard);
    }
  });

  test("a removal racing an adoption still lands: the app is not added back", async () => {
    for (let round = 0; round < 5; round++) {
      await reset();
      const [id] = await defaults().adoptSources(owner, bot);
      // The removal records the turn-down before it deletes the source in Intelligence, and adoption
      // reads the sources before the turn-downs, so however these interleave the app stays removed.
      await Promise.all([
        memory.removeSource(owner, id as string),
        defaults().adoptSources(owner, bot),
        defaults().adoptSources(owner, bot),
      ]);
      expect(await sourcesOf(owner, bot)).toEqual([]);
      expect(await defaults().adoptSources(owner, bot)).toEqual([]);
    }
  });

  test("two instances adopting the same default at once make one source", async () => {
    await reset();
    // Each with its own cache, as two replicas are.
    const replica = testMemory(database).store;
    const [first, second] = await Promise.all([
      defaults().adoptSources(owner, bot),
      defaults({ memory: replica }).adoptSources(owner, bot),
    ]);
    const sources = await sourcesOf(owner, bot);
    expect(sources).toHaveLength(1);
    expect([...(first ?? []), ...(second ?? [])]).toContain(sources[0]?.id);
  });

  test("a source made by hand on the app counts as the person's choice", async () => {
    await reset();
    await memory.createSource(owner, {
      agentId: bot,
      toolRef: `${app}/LINEAR_LIST_LABELS`,
      title: "Labels",
      args: {},
    });
    expect(await defaults().adoptSources(owner, bot)).toEqual([]);
  });

  test("isolation is unchanged: an imported fact reaches its own Bot and person only", async () => {
    await reset();
    const [id] = await defaults().adoptSources(owner, bot);
    await memory.completeSync(owner, id as string, [
      {
        externalId: "ISSUE-1",
        content: "The login bug ships Friday",
        provenance: "ISSUE-1",
        digest: "digest-issue-1",
      },
    ]);
    const recalled = (person: string, agentId: string) =>
      ingestion
        .recall(person, agentId)
        .then((rows) => rows.map((row) => row.content));
    expect(await recalled(owner, bot)).toContain("The login bug ships Friday");
    expect(await recalled(owner, secondBot)).not.toContain(
      "The login bug ships Friday",
    );
    expect(await recalled(other, bot)).not.toContain(
      "The login bug ships Friday",
    );
  });

  // A Team Bot somebody else published reaches a person's own accounts only with their consent.
  test("a Team Bot somebody else published gets none of the person's apps by default", async () => {
    await reset();
    const asked: string[] = [];
    const theirs = defaults({
      publishedByAnother: async (person, agentId) => {
        asked.push(`${person}:${agentId}`);
        return true;
      },
    });
    expect(await theirs.adoptSources(owner, bot)).toEqual([]);
    expect(await sourcesOf(owner, bot)).toEqual([]);
    expect(asked).toEqual([`${owner}:${bot}`]);
    const mine = defaults({ publishedByAnother: async () => false });
    expect(await mine.adoptSources(owner, bot)).toHaveLength(1);
  });

  test("the deployment switch stops new sources", async () => {
    await reset();
    expect(await defaults({ sources: false }).adoptSources(owner, bot)).toEqual(
      [],
    );
  });
});

describe("background research, on by default", () => {
  const channel = `channel-${suite}`;

  test("a fresh person gets hourly check-ins from the Bot they talk to, the first an hour out", async () => {
    await reset();
    const before = Date.now();
    expect(await defaults().adoptResearch(owner, bot, channel)).toBe(true);
    const [setting] = await researchOf(owner, bot);
    expect(DEFAULT_RESEARCH_INTERVAL_MINUTES).toBe(60);
    expect(setting).toMatchObject({
      channelId: channel,
      enabled: true,
      intervalMinutes: 60,
      lastStatus: "idle",
    });
    expect(setting?.nextRunAt.getTime()).toBeGreaterThanOrEqual(
      before + 60 * 60_000 - 1_000,
    );
    expect(setting?.nextRunAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 60 * 60_000 + 1_000,
    );
    // Not due, so the sweep does not take it.
    expect(
      (await proactive.claimDue(10)).some((row) => row.id === setting?.id),
    ).toBe(false);
    expect(await defaults().adoptResearch(owner, bot, channel)).toBe(false);
    expect(await researchOf(owner, bot)).toHaveLength(1);
  });

  test("research the person turned off stays off", async () => {
    await reset();
    await defaults().adoptResearch(owner, bot, channel);
    const [setting] = await researchOf(owner, bot);
    await proactive.update(owner, setting?.id as string, { enabled: false });
    expect(await defaults().adoptResearch(owner, bot, channel)).toBe(false);
    expect(await researchOf(owner, bot)).toMatchObject([{ enabled: false }]);
  });

  test("research the person removed is never switched back on", async () => {
    await reset();
    await defaults().adoptResearch(owner, bot, channel);
    const [setting] = await researchOf(owner, bot);
    await proactive.remove(owner, setting?.id as string);
    expect(await defaults().adoptResearch(owner, bot, channel)).toBe(false);
    expect(await researchOf(owner, bot)).toEqual([]);
  });

  test("never into a conversation the Bot cannot deliver to, and not when switched off", async () => {
    await reset();
    expect(await defaults().adoptResearch(other, bot, channel)).toBe(false);
    expect(
      await defaults({ research: false }).adoptResearch(owner, bot, channel),
    ).toBe(false);
    expect(await researchOf(owner, bot)).toEqual([]);
  });

  test("speaking in a conversation with one Bot switches both on; a group conversation does not", async () => {
    await reset();
    defaults({ channelBots: async () => [bot, secondBot] }).personSpoke(
      owner,
      channel,
    );
    await Bun.sleep(200);
    expect(await researchOf(owner, bot)).toEqual([]);
    expect(await sourcesOf(owner, bot)).toEqual([]);
    defaults().personSpoke(owner, channel);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (
        (await researchOf(owner, bot)).length &&
        (await sourcesOf(owner, bot)).length
      )
        break;
      await Bun.sleep(50);
    }
    expect(await researchOf(owner, bot)).toHaveLength(1);
    expect(await sourcesOf(owner, bot)).toHaveLength(1);
  });
});
