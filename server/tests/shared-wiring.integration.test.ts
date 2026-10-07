// server/tests/shared-wiring.integration.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { mcpServers } from "../src/db/schema";
import { createAccountModeSwitch } from "../src/plugins/account-mode";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { createSharedUseStore } from "../src/plugins/shared-use-store";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/*
 * Every Shared-app surface was once built, tested through its own factory, and never mounted: the
 * route tests passed while production answered 404. These go through `createApp` itself, so a
 * surface that is not wired in fails here rather than in front of an administrator.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const app = `wired-${suite}`;

const broker: ConnectedAppBroker = {
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async () => ({ redirectUrl: "https://vendor.example/consent" }),
  isConnected: async () => true,
  revoke: async () => true,
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => null,
};

function build(options: { shared: boolean }) {
  const auditStore = createAuditStore(database);
  const pluginStore = createPluginStore({
    database,
    auditStore,
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
    deploymentId: `acme-${suite}`,
  });
  const use = createSharedUseStore(database);
  const modes = createAccountModeSwitch({
    store: pluginStore,
    sharedUse: use,
    teamRules: undefined,
    deploymentId: `acme-${suite}`,
    audit: auditStore,
  });
  /*
   * Positional, 37 long. Placed by index rather than by a run of `undefined`s, so a parameter added
   * in the middle moves a type error onto the wrong index here instead of silently shifting `shared`.
   */
  const args = new Array(createApp.length) as unknown as Parameters<
    typeof createApp
  >;
  args[0] = loadConfig(testEnvironment());
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => ({
        user: {
          id: `admin-${suite}`,
          email: `admin-${suite}@example.test`,
          name: "Admin",
        },
      }),
    },
  } as never;
  args[2] = { rolesForUser: async () => ["admin"] } as never;
  args[12] = auditStore;
  args[14] = pluginStore;
  if (options.shared) args[36] = { modes, use };
  return createApp(...args);
}

beforeEach(async () => {
  await database.insert(mcpServers).values({
    id: app,
    title: "Team GitHub",
    vendor: "Composio",
    url: `composio://${app}`,
    provenance: "composio",
    authScheme: "OAUTH2",
    accountMode: "personal",
  });
});
afterEach(async () => {
  await database.delete(mcpServers).where(eq(mcpServers.id, app));
});

describe("a deployment built with shared apps", () => {
  test("serves the administrators' request inbox", async () => {
    const response = await build({ shared: true }).request(
      "http://openbot.test/api/approvals/shared-use",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ requests: [] });
  });

  test("serves the Personal or Shared switch", async () => {
    const response = await build({ shared: true }).request(
      `http://openbot.test/api/plugins/servers/${app}/account-mode`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "shared" }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      changed: false,
      preview: { mode: "shared" },
    });
  });
});

describe("a deployment built without them", () => {
  test("says the switch is unavailable rather than pretending to switch", async () => {
    const response = await build({ shared: false }).request(
      `http://openbot.test/api/plugins/servers/${app}/account-mode`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "shared", confirm: true }),
      },
    );
    expect(response.status).toBe(503);
  });
});
