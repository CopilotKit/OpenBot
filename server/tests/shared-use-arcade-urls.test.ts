// server/tests/shared-use-arcade-urls.test.ts
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { mcpServers, users } from "../src/db/schema";
import type { BrokerProvider } from "../src/plugins/access";
import { createSharedUseStore } from "../src/plugins/shared-use-store";
import {
  grantBot,
  removeBots,
  seedBot,
  useTestConfiguration,
} from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { useTestPolicy } from "./support/policy";

// Shared app approvals and approval rules are Intelligence's organization policy.
beforeAll(async () => {
  await useTestPolicy();
});

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

beforeAll(async () => {
  await useTestConfiguration();
});
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `${name}-${suite}`;

/** Two rows at one app url, the lower id first, and a Bot granted through the HIGHER one only. */
const lowId = id("a-row");
const highId = id("b-row");
const bot = id("bot");
const owner = id("owner");

const spec: Record<BrokerProvider, { toolkit: string; scheme: string }> = {
  composio: { toolkit: `gmail${suite}`, scheme: "composio://" },
  arcade: { toolkit: `Gmail${suite}`, scheme: "arcade://" },
};

async function cleanup() {
  await removeBots([bot]);
  await database
    .delete(mcpServers)
    .where(inArray(mcpServers.id, [lowId, highId]));
  await database.delete(users).where(eq(users.id, owner));
}

async function seed(provider: BrokerProvider) {
  const url = `${spec[provider].scheme}${spec[provider].toolkit}`;
  await database.insert(users).values({
    id: owner,
    email: `${owner}@example.test`,
    name: "owner",
    emailVerified: true,
    groups: [],
  });
  for (const rowId of [lowId, highId])
    await database.insert(mcpServers).values({
      id: rowId,
      title: `Team ${rowId}`,
      vendor: provider,
      url,
      provenance: provider,
      authScheme: "OAUTH2",
      accountMode: "shared",
      sharedVendorUserId: "openbot-deployment:x:R",
    });
  await seedBot({
    id: bot,
    name: "Triage",
    type: "built_in",
    configuration: { systemPrompt: "" },
    ownerUserId: owner,
    visibility: "private",
    title: "Triage",
    roleDescription: "Triage",
    avatarSeed: "x",
  });
  await grantBot(bot, "mcp", `${highId}/ACTION`, {
    grantedBy: "admin@example.test",
  });
}

beforeEach(cleanup);
afterAll(cleanup);
/* The pool this file opened, given back. `bun test` runs every file in one process and nothing
 * reaps an idle connection, so a pool held to the end of the run is two connections the rest of
 * the suite cannot have. */
afterAll(async () => {
  await database.$client.close();
});

for (const provider of ["arcade", "composio"] as const) {
  describe(`shared use urls under ${provider}`, () => {
    test("two rows at one url are ONE app and the lower id answers", async () => {
      await seed(provider);
      const store = createSharedUseStore(database, provider);
      expect(await store.appIdOf(highId)).toBe(lowId);
      expect(await store.appIdOf(lowId)).toBe(lowId);
    });

    test("sharedAppsHeldBy lists the app, under the answering row", async () => {
      await seed(provider);
      const store = createSharedUseStore(database, provider);
      const held = await store.sharedAppsHeldBy(bot);
      expect(held.map((app) => app.serverId)).toEqual([lowId]);
    });

    test("botsHolding finds a Bot granted through the sibling row", async () => {
      await seed(provider);
      const store = createSharedUseStore(database, provider);
      expect(await store.botsHolding(lowId)).toEqual([bot]);
      expect(await store.botsHolding(highId)).toEqual([bot]);
    });
  });
}
