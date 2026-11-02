// server/tests/gate-grant-is-local.test.ts
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agents,
  brokeredConnections,
  mcpServers,
  mcpTools,
} from "../src/db/schema";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { useComposioClient } from "../src/plugins/composio";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

/* The pool this file opened, given back. `bun test` runs every file in one process and nothing
 * reaps an idle connection, so a pool held to the end of the run is two connections the rest of
 * the suite cannot have. */
afterAll(async () => {
  await database.$client.close();
});
const suite = randomUUID().slice(0, 8);
const shared = `team-gh-${suite}`;
const personal = `my-gh-${suite}`;
const bot = `bot-${suite}`;
const admin = `admin-${suite}`;
const asker = `asker-${suite}`;
const VENDOR_ID = `openbot-deployment:acme-${suite}:R`;

/*
 * THE ONE VARIABLE IN THIS FILE IS A DECLARED PROPERTY, NOT A VENDOR NAME.
 *
 * Every store below is built with `brokerProvider: "composio"`, over Composio's own url scheme,
 * provenance and transport. The only thing that differs between the refusing case and the
 * proceeding one is `grantIsLocal` on the broker object — which is the assertion that the gate in
 * `connectionTokenFor` reads the property and could not be reading the vendor's name, because the
 * name is identical in all three tests.
 */
const brokerStub: Omit<ConnectedAppBroker, "grantIsLocal"> = {
  // Nothing here reads either member; both are declared because the seam requires a broker to
  // SAY what it runs — see `ConnectedAppBroker.authorizations`.
  authorizations: null,
  // Nothing here asks what auth provider a connection is held under.
  authProviderOf: async () => null,
  grantsFor: async () => [],
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async () => ({
    redirectUrl: "https://vendor.example/consent",
    authorizationId: null,
  }),
  isConnected: async () => true,
  revoke: async () => true,
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => "acme-bot",
};

const policy = { mode: "enforce" as const, deny: [], allow: ["true"] };
const credentialsStub = {} as never;

/** The ids the transport was actually handed, which is the only place identity is observable. */
function recordingTransport(sentAs: string[]) {
  useComposioClient({
    listActions: async () => [],
    execute: async ({ userId }) => {
      sentAs.push(userId);
      return { successful: true, data: {}, error: null } as never;
    },
  });
}

function storeWith(grantIsLocal: boolean) {
  return createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: credentialsStub,
    encryptionKey: "x".repeat(44),
    policy: () => policy,
    broker: { ...brokerStub, grantIsLocal },
    deploymentId: `acme-${suite}`,
    sharedUse: async () => ({ allowed: true }),
  });
}

/** An app at its own url, with one action and NO connection row anywhere. */
async function seed(app: string, mode: "shared" | "personal") {
  await database.insert(mcpServers).values({
    id: app,
    title: "Team GitHub",
    vendor: "Composio",
    url: `composio://${app}`,
    provenance: "composio",
    authScheme: "OAUTH2",
    accountMode: mode,
    sharedVendorUserId: mode === "shared" ? VENDOR_ID : null,
  });
  await database.insert(mcpTools).values({
    serverId: app,
    name: "GITHUB_LIST_ISSUES",
    vendorName: "GITHUB_LIST_ISSUES",
    description: "List issues.",
    effect: "read",
    version: "1",
  });
}

async function clean() {
  for (const app of [shared, personal]) {
    await database
      .delete(brokeredConnections)
      .where(eq(brokeredConnections.app, app));
    await database.delete(mcpServers).where(eq(mcpServers.id, app));
  }
  await database.delete(agents).where(eq(agents.id, bot));
}

beforeEach(async () => {
  await clean();
  await database
    .insert(agents)
    .values({ id: bot, name: "Helper", type: "built_in", configuration: {} });
});
afterEach(async () => {
  useComposioClient(null);
  await clean();
});

describe("connectionTokenFor asks the broker where the grant lives", () => {
  test("a local grant with no connection row refuses in today's words", async () => {
    const sentAs: string[] = [];
    recordingTransport(sentAs);
    const store = storeWith(true);
    await seed(shared, "shared");
    await store.grant(
      "mcp",
      `${shared}/GITHUB_LIST_ISSUES`,
      bot,
      `${admin}@example.test`,
    );

    await expect(
      store.callTool({
        ref: `${shared}/GITHUB_LIST_ISSUES`,
        args: {},
        botId: bot,
        actorId: asker,
      }),
    ).rejects.toThrow(
      "Team GitHub uses a shared account, and nobody has connected it yet. Ask an admin to connect it.",
    );
    expect(sentAs).toEqual([]);
  });

  test("a vendor-held grant with no connection row lets the call through", async () => {
    const sentAs: string[] = [];
    recordingTransport(sentAs);
    const store = storeWith(false);
    await seed(personal, "personal");
    await store.grant(
      "mcp",
      `${personal}/GITHUB_LIST_ISSUES`,
      bot,
      `${admin}@example.test`,
    );

    const answer = await store.callTool({
      ref: `${personal}/GITHUB_LIST_ISSUES`,
      args: {},
      botId: bot,
      actorId: asker,
    });
    expect(answer.isError).toBe(false);
    expect(sentAs).toEqual([asker]);
  });

  /*
   * THE ASSERTION THAT THIS REMOVED A PRECONDITION AND NOT AN AUTHORIZATION.
   *
   * A Shared app still acts as the deployment, whoever asks and whether or not a row exists. The
   * identity is derived from the app's mode exactly as before — the asker cannot name it — so what
   * the transport is handed is the app's `shared_vendor_user_id`, never `asker`.
   */
  test("a vendor-held grant on a Shared app still runs as the app's shared identity", async () => {
    const sentAs: string[] = [];
    recordingTransport(sentAs);
    const store = storeWith(false);
    await seed(shared, "shared");
    await store.grant(
      "mcp",
      `${shared}/GITHUB_LIST_ISSUES`,
      bot,
      `${admin}@example.test`,
    );

    const answer = await store.callTool({
      ref: `${shared}/GITHUB_LIST_ISSUES`,
      args: {},
      botId: bot,
      actorId: asker,
    });
    expect(answer.isError).toBe(false);
    expect(sentAs).toEqual([VENDOR_ID]);
    expect(sentAs).not.toContain(asker);
  });
});
