// server/tests/shared-brokered-routes.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { brokeredConnections, mcpServers } from "../src/db/schema";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const app = `team-gh-${suite}`;
const VENDOR_ID = `openbot-deployment:acme-${suite}:R`;
const authorizedFor: string[] = [];
const returnUrlsSeen: string[] = [];
let connectWithFieldsCalls = 0;

const broker: ConnectedAppBroker = {
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async ({ account, returnUrl }) => {
    authorizedFor.push(account.vendorUserId);
    returnUrlsSeen.push(returnUrl);
    return { redirectUrl: "https://vendor.example/consent" };
  },
  isConnected: async () => true,
  revoke: async () => true,
  connectionFields: async () => [],
  connectWithFields: async () => {
    connectWithFieldsCalls += 1;
    return { accountId: "ca_1" };
  },
  revokeAccount: async () => {},
  accountName: async () => "acme-bot",
};

function appAs(role: "admin" | "user", id = `${role}-${suite}`) {
  const store = createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
    deploymentId: `acme-${suite}`,
  });
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id, email: `${id}@example.test`, role } as never);
    await next();
  };
  return new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      store,
      signedIn,
      async () => true,
      {
        publicUrl: "https://openbot.example",
        appUrl: "https://app.example",
        encryptionKey: "A".repeat(43) + "=",
        personHasAccess: async () => true,
      },
      { broker },
    ),
  );
}

beforeEach(async () => {
  authorizedFor.length = 0;
  returnUrlsSeen.length = 0;
  connectWithFieldsCalls = 0;
  await database.insert(mcpServers).values({
    id: app,
    title: "Team GitHub",
    vendor: "Composio",
    url: `composio://${app}`,
    provenance: "composio",
    authScheme: "OAUTH2",
    accountMode: "shared",
    sharedVendorUserId: VENDOR_ID,
  });
});
afterEach(async () => {
  await database
    .delete(brokeredConnections)
    .where(eq(brokeredConnections.app, app));
  await database.delete(mcpServers).where(eq(mcpServers.id, app));
});

describe("connecting a shared app", () => {
  test("a non-admin is refused before anything is asked of the vendor", async () => {
    const response = await appAs("user").request(
      `/api/plugins/servers/${app}/connect`,
      { method: "POST" },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "An administrator connects shared apps.",
    });
    expect(authorizedFor).toEqual([]);
  });

  test("an admin begins consent under the deployment's identity, not their own", async () => {
    const response = await appAs("admin").request(
      `/api/plugins/servers/${app}/connect?returnTo=admin`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(authorizedFor).toEqual([VENDOR_ID]);
  });

  test("a holder named in the body changes nothing", async () => {
    await appAs("admin").request(`/api/plugins/servers/${app}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holder: "person", vendorUserId: "someone-else" }),
    });
    expect(authorizedFor).toEqual([VENDOR_ID]);
  });

  test("confirming writes the deployment row, recording who connected it", async () => {
    const response = await appAs("admin", `admin-${suite}`).request(
      `/api/plugins/servers/${app}/connection/confirm`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const [row] = await database
      .select()
      .from(brokeredConnections)
      .where(eq(brokeredConnections.app, app));
    expect(row).toMatchObject({
      holder: "deployment",
      userId: null,
      vendorUserId: VENDOR_ID,
      connectedBy: `admin-${suite}`,
    });
  });

  test("a non-admin cannot confirm, re-check or disconnect it", async () => {
    const user = appAs("user");
    for (const [path, method] of [
      ["connection/confirm", "POST"],
      ["connection/recheck", "POST"],
      ["connection", "DELETE"],
    ] as const) {
      const response = await user.request(
        `/api/plugins/servers/${app}/${path}`,
        { method },
      );
      expect(response.status).toBe(403);
    }
  });

  test("an existing deployment account refuses a second connect, naming the app rather than the person", async () => {
    await database.insert(brokeredConnections).values({
      provider: "composio",
      app,
      holder: "deployment",
      vendorUserId: VENDOR_ID,
      connectedBy: `admin-${suite}`,
      verified: true,
    });
    const response = await appAs("admin").request(
      `/api/plugins/servers/${app}/connect`,
      { method: "POST" },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "Team GitHub already has a shared account connected. Disconnect it first if you want to connect a different one.",
    });
  });

  test("an admin lands back on the admin page even without ?returnTo=admin", async () => {
    const response = await appAs("admin").request(
      `/api/plugins/servers/${app}/connect`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(returnUrlsSeen).toHaveLength(1);
    expect(returnUrlsSeen[0]).toContain("/admin/plugins/");
  });

  test("a non-admin cannot connect a key-type shared app either, and nothing is sent to the vendor", async () => {
    const keyApp = `${app}-key`;
    await database.insert(mcpServers).values({
      id: keyApp,
      title: "Team GitHub Key",
      vendor: "Composio",
      url: `composio://${keyApp}`,
      provenance: "composio",
      authScheme: "API_KEY",
      accountMode: "shared",
      sharedVendorUserId: `openbot-deployment:acme-${suite}:K`,
    });
    try {
      const response = await appAs("user").request(
        `/api/plugins/servers/${keyApp}/connect`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values: { api_key: "secret" } }),
        },
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "An administrator connects shared apps.",
      });
      expect(connectWithFieldsCalls).toBe(0);
    } finally {
      await database.delete(mcpServers).where(eq(mcpServers.id, keyApp));
    }
  });
});

describe("GET /connections", () => {
  test("lists a shared app once as the deployment's, with its display name, for anyone", async () => {
    await database.insert(brokeredConnections).values({
      provider: "composio",
      app,
      holder: "deployment",
      vendorUserId: VENDOR_ID,
      connectedBy: `admin-${suite}`,
      verified: true,
    });
    const body = (await (
      await appAs("user").request("/api/plugins/connections")
    ).json()) as {
      connections: {
        serverId: string;
        holder: string;
        displayName?: string | null;
        connected?: boolean;
      }[];
    };
    const shared = body.connections.filter((row) => row.serverId === app);
    expect(shared).toEqual([
      expect.objectContaining({
        holder: "deployment",
        connected: true,
        displayName: "acme-bot",
      }),
    ]);
  });

  test("lists an unconnected shared app as not connected rather than leaving it out", async () => {
    const body = (await (
      await appAs("user").request("/api/plugins/connections")
    ).json()) as {
      connections: { serverId: string; holder: string; connected?: boolean }[];
    };
    expect(body.connections.filter((row) => row.serverId === app)).toEqual([
      expect.objectContaining({ holder: "deployment", connected: false }),
    ]);
  });
});
