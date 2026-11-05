import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { MCPMock } from "@copilotkit/aimock/mcp";
import { eq, inArray, like } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { enterpriseSettings } from "../src/db/schema/admin";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { mcpServers, pluginGrants } from "../src/db/schema/plugins";
import { setEdition } from "../src/edition";
import {
  DEFAULT_APPS_SETTING,
  ensurePersonalDefaultApps,
  personalDefaultAppsMemory,
  personalDefaultsDeps,
  startPersonalDefaultApps,
  withPersonalDefaults,
} from "../src/plugins/personal-defaults";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Parallel's keyless web search, on from the personal edition's first start, through the store and
 * the startup step the server runs (`server/src/index.ts`), against a real database. Parallel itself
 * is a local MCP server answering at search.parallel.ai's address, or no answer at all for offline.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `default-apps-owner-${suite}`;
const assistant = `default-apps-assistant-${suite}`;
const later = `default-apps-later-${suite}`;
const PARALLEL = "parallel";
const SEARCH = ["parallel/web_fetch", "parallel/web_search"];

const store = withPersonalDefaults(
  createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: createCredentialStore(database),
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    brokerProvider: "composio",
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  }),
  scopedDeps(),
);
const memory = personalDefaultAppsMemory(database);

/** The real reads, with the Bots narrowed to this suite's so nobody else's are given anything. */
function scopedDeps() {
  const real = personalDefaultsDeps(database);
  return {
    ...real,
    bots: async () =>
      (await real.bots()).filter((id) => id.startsWith("default-apps-")),
  };
}
const deps = scopedDeps();

/** A start of the server: what `index.ts` runs for the default apps. */
const restart = () => ensurePersonalDefaultApps(store, deps, memory);

const mock = new MCPMock();
let mockUrl = "";
let online = true;
const realFetch = globalThis.fetch;

async function held(bot: string) {
  const { tools } = await store.listForAgent(bot);
  return tools
    .map((tool) => tool.ref)
    .filter((ref) => ref.startsWith(`${PARALLEL}/`))
    .sort();
}

async function addBot(id: string) {
  await database
    .insert(agents)
    .values({ id, name: id, type: "built_in", configuration: {} });
  await database.insert(agentProfiles).values({
    agentId: id,
    ownerUserId: owner,
    title: id,
    roleDescription: "Assist",
    avatarSeed: id,
    visibility: "private",
  });
}

async function forgetParallel() {
  await database
    .delete(pluginGrants)
    .where(like(pluginGrants.ref, `${PARALLEL}/%`));
  await database.delete(mcpServers).where(eq(mcpServers.id, PARALLEL));
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, DEFAULT_APPS_SETTING));
}

beforeAll(async () => {
  mock.addTool({
    name: "web_search",
    description: "Search the public web.",
    inputSchema: {
      type: "object",
      properties: { objective: { type: "string" } },
    },
  });
  mock.addTool({
    name: "web_fetch",
    description: "Read public web pages.",
    inputSchema: { type: "object", properties: { urls: { type: "array" } } },
  });
  mockUrl = await mock.start();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    if (!target.startsWith("https://search.parallel.ai"))
      return realFetch(input, init);
    if (!online) return Promise.reject(new TypeError("fetch failed"));
    return realFetch(mockUrl, init);
  }) as typeof fetch;
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await addBot(assistant);
});

beforeEach(async () => {
  online = true;
  setEdition("personal");
  await forgetParallel();
  await database.delete(agents).where(eq(agents.id, later));
});

afterEach(() => setEdition("team"));

afterAll(async () => {
  globalThis.fetch = realFetch;
  await mock.stop?.();
  await forgetParallel();
  await database.delete(agents).where(inArray(agents.id, [assistant, later]));
  await database.delete(users).where(eq(users.id, owner));
  await database.$client.close();
});

describe("Parallel Search in the personal edition", () => {
  test("a fresh start turns it on and the Bot holds web_search and web_fetch", async () => {
    expect(await restart()).toEqual([]);
    expect(await store.serverAddress(PARALLEL)).toBeDefined();
    expect(await held(assistant)).toEqual(SEARCH);
  });

  test("a Bot made later holds them too", async () => {
    await restart();
    await addBot(later);
    expect(await held(later)).toEqual(SEARCH);
  });

  test("turned off, it stays off after a restart", async () => {
    await restart();
    await store.removeServer(PARALLEL, owner);
    expect(await restart()).toEqual([]);
    expect(await store.serverAddress(PARALLEL)).toBeUndefined();
    expect(await held(assistant)).toEqual([]);
  });

  test("an app the person already added is left as it is", async () => {
    await store.addServer({ key: PARALLEL, by: owner });
    await restart();
    const [row] = await database
      .select({ addedBy: mcpServers.addedBy })
      .from(mcpServers)
      .where(eq(mcpServers.id, PARALLEL));
    expect(row?.addedBy).toBe(owner);
    expect((await memory.added()).has(PARALLEL)).toBe(true);
  });

  test("an offline start still starts, and the next start finishes it", async () => {
    online = false;
    expect(await restart()).toEqual([PARALLEL]);
    expect(await held(assistant)).toEqual([]);

    online = true;
    expect(await restart()).toEqual([]);
    expect(await held(assistant)).toEqual(SEARCH);
  });

  test("while it runs, it finishes on its own when the network comes back", async () => {
    online = false;
    const stop = startPersonalDefaultApps(store, deps, memory, [25]);
    try {
      await waitFor(
        async () => (await store.serverAddress(PARALLEL)) !== undefined,
      );
      expect(await held(assistant)).toEqual([]);
      online = true;
      await waitFor(async () => (await held(assistant)).length === 2);
      expect(await held(assistant)).toEqual(SEARCH);
    } finally {
      stop();
    }
  });
});

test("the team edition turns nothing on", async () => {
  setEdition("team");
  expect(await restart()).toEqual([]);
  startPersonalDefaultApps(store, deps, memory, [25])();
  await Bun.sleep(100);
  expect(await store.serverAddress(PARALLEL)).toBeUndefined();
  expect(await memory.added()).toEqual(new Set());
  expect(await held(assistant)).toEqual([]);
});

async function waitFor(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(25);
  }
}
