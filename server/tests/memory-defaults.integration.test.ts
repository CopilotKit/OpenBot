import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { defaultOptOuts } from "../src/db/schema/defaults";
import { memorySources } from "../src/db/schema/memory";
import {
  brokeredConnections,
  mcpServers,
  mcpTools,
} from "../src/db/schema/plugins";
import { proactiveSettings } from "../src/db/schema/proactive";
import {
  createMemoryDefaults,
  DEFAULT_RESEARCH_INTERVAL_MINUTES,
  lockDefaults,
} from "../src/memory/defaults";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { createMemoryStore } from "../src/memory/store";
import { createPluginStore } from "../src/plugins/store";
import { createProactiveStore } from "../src/proactive/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `defaults-owner-${suite}`;
const other = `defaults-other-${suite}`;
const bot = `defaults-bot-${suite}`;
const secondBot = `defaults-second-${suite}`;
const app = `linear-${suite}`;
const unconnected = `notes-${suite}`;
const plugins = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  // This suite's apps are `composio://` rows with `provenance: "composio"`, and the store has no
  // default for this: it dispatches the toolkit read on it, so the fixtures name their own broker.
  brokerProvider: "composio",
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async () => ({ text: "[]", isError: false }),
});
const memory = createMemoryStore(database);
const ingestion = createMemoryIngestion({ store: memory, plugins });
const proactive = createProactiveStore(database);
const synced: string[] = [];

function defaults(
  overrides: Partial<Parameters<typeof createMemoryDefaults>[0]> = {},
) {
  return createMemoryDefaults({
    database,
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

const sourcesOf = (person: string, agentId: string) =>
  database
    .select()
    .from(memorySources)
    .where(
      and(
        eq(memorySources.ownerUserId, person),
        eq(memorySources.agentId, agentId),
      ),
    );
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
  await database
    .delete(memorySources)
    .where(inArray(memorySources.ownerUserId, [owner, other]));
  await database
    .delete(proactiveSettings)
    .where(inArray(proactiveSettings.ownerUserId, [owner, other]));
  await database
    .delete(defaultOptOuts)
    .where(inArray(defaultOptOuts.ownerUserId, [owner, other]));
}

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  await database.insert(agents).values(
    [bot, secondBot].map((id) => ({
      id,
      name: id,
      type: "built_in" as const,
      configuration: {},
    })),
  );
  await database.insert(agentProfiles).values(
    [bot, secondBot].map((agentId) => ({
      agentId,
      ownerUserId: owner,
      title: agentId,
      roleDescription: "Assist",
      avatarSeed: agentId,
      visibility: "private" as const,
    })),
  );
  await database.insert(mcpServers).values([
    {
      id: app,
      title: "Linear",
      vendor: "Composio",
      url: `composio://${app}`,
      provenance: "composio",
      authScheme: "OAUTH2",
      accountMode: "personal",
    },
    {
      id: unconnected,
      title: "Notes",
      vendor: "Composio",
      url: `composio://${unconnected}`,
      provenance: "composio",
      authScheme: "OAUTH2",
      accountMode: "personal",
    },
  ]);
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
  await database.insert(brokeredConnections).values({
    provider: "composio",
    app,
    holder: "person",
    userId: owner,
    vendorUserId: owner,
  });
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.delete(agents).where(inArray(agents.id, [bot, secondBot]));
  await database
    .delete(mcpServers)
    .where(inArray(mcpServers.id, [app, unconnected]));
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
      await database
        .select({
          feature: defaultOptOuts.feature,
          scope: defaultOptOuts.scope,
        })
        .from(defaultOptOuts)
        .where(eq(defaultOptOuts.ownerUserId, owner)),
    ).toEqual([{ feature: "memory_source", scope: app }]);
    // The person's other Bot is a separate choice.
    expect(await defaults().adoptSources(owner, secondBot)).toHaveLength(1);
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

  test("a fresh person gets research from the Bot they talk to, read-only and a full interval out", async () => {
    await reset();
    const before = Date.now();
    expect(await defaults().adoptResearch(owner, bot, channel)).toBe(true);
    const [setting] = await researchOf(owner, bot);
    expect(setting).toMatchObject({
      channelId: channel,
      enabled: true,
      intervalMinutes: DEFAULT_RESEARCH_INTERVAL_MINUTES,
      lastStatus: "idle",
    });
    expect(setting?.nextRunAt.getTime()).toBeGreaterThanOrEqual(
      before + DEFAULT_RESEARCH_INTERVAL_MINUTES * 60_000 - 1_000,
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
