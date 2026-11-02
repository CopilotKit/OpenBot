// server/tests/arcade-grants-route.test.ts
/**
 * `GET /api/plugins/servers/:id/grants`: what an account holds at an app, action by action.
 *
 * THE IDENTITY SENT UPSTREAM IS WHAT IS ASSERTED, never what rendered. The stub broker records the
 * `account` each `grantsFor` call receives, and cases 1 and 2 read THAT. A route that asked about
 * the viewer for a Shared app would render a perfectly plausible answer.
 *
 * SCOPING. `audit_events` is append-only and nothing here is cleaned between cases, so every case
 * mints its own `run()`: a fresh `suite+counter` suffix on the toolkit, the app id, the viewer and
 * the shared identity. The captured calls are filtered to THIS case's toolkit, and the "mint
 * refused" check reads `audit_events` and `pending_authorizations` through `inArray` on this case's
 * own names only, so a minted attempt by any other case could not satisfy or redden it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  mcpServers,
  pendingAuthorizations,
} from "../src/db/schema";
import type { ConnectedAppBroker, GrantState } from "../src/plugins/broker";
import type { AccountRef } from "../src/plugins/shared-accounts";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
let counter = 0;

type Provider = "arcade" | "composio";
let calls: { toolkit: string; account: AccountRef }[] = [];
let mints: string[] = [];
let answer: (q: {
  toolkit: string;
  account: AccountRef;
}) => Promise<GrantState[]> = async () => [];

const recordGrants: ConnectedAppBroker["grantsFor"] = async (q) => {
  calls.push(q);
  return answer(q);
};

/** Declares the correlated flow and mints an authorization id: Arcade's shape. */
const arcadeBroker: ConnectedAppBroker = {
  grantIsLocal: false,
  authProviderOf: async () => "google",
  authorizations: {
    status: async () => ({ status: "pending", userId: null, scopes: [] }),
    confirmReturn: async () => ({ mismatch: true }),
  },
  grantsFor: recordGrants,
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async (request) => {
    mints.push(request.toolkit);
    return {
      redirectUrl: "https://vendor.example/consent?bearer=1",
      authorizationId: "ar_1",
    };
  },
  isConnected: async () => true,
  revoke: async () => true,
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => null,
};

/** Declares no flow, mints no authorization id, and still answers `grantsFor`. */
const composioBroker: ConnectedAppBroker = {
  grantIsLocal: false,
  authProviderOf: async () => "google",
  authorizations: null,
  grantsFor: recordGrants,
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async (request) => {
    mints.push(request.toolkit);
    return {
      redirectUrl: "https://vendor.example/consent?bearer=1",
      authorizationId: null,
    };
  },
  isConnected: async () => true,
  revoke: async () => true,
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => null,
};

const brokerFor = (provider: Provider) =>
  provider === "arcade" ? arcadeBroker : composioBroker;

function build(who: string, role: "admin" | "user", provider: Provider) {
  const broker = brokerFor(provider);
  const auditStore = createAuditStore(database);
  const pluginStore = createPluginStore({
    brokerProvider: provider,
    database,
    auditStore,
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
    deploymentId: `acme-${suite}`,
  });
  const args = new Array(createApp.length) as unknown as Parameters<
    typeof createApp
  >;
  args[0] = loadConfig(
    testEnvironment({ OPENBOT_APP_URL: "https://app.example" }),
  );
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => ({
        user: { id: who, email: `${who}@example.test`, name: "Person" },
      }),
    },
  } as never;
  args[2] = { rolesForUser: async () => [role] } as never;
  args[12] = auditStore;
  args[14] = pluginStore;
  args[29] = { broker, provider };
  return createApp(...args);
}

const ids: string[] = [];
const toolkits: string[] = [];
const viewers: string[] = [];

/** This case's own names. Nothing another case writes can share one. */
async function run(mode: "personal" | "shared", provider: Provider = "arcade") {
  counter += 1;
  const tag = `${suite}${counter}`;
  const names = {
    id: `grants-${tag}`,
    toolkit: `Gmail${tag}`,
    viewer: `viewer-${tag}`,
    sharedIdentity: `openbot-deployment:acme:${tag}`,
  };
  ids.push(names.id);
  toolkits.push(names.toolkit);
  viewers.push(names.viewer);
  await database.insert(mcpServers).values({
    id: names.id,
    title: "Gmail",
    vendor: provider === "arcade" ? "Arcade" : "Composio",
    url: `${provider}://${names.toolkit}`,
    provenance: provider,
    authScheme: "OAUTH2",
    accountMode: mode,
    sharedVendorUserId: mode === "shared" ? names.sharedIdentity : null,
  });
  calls = [];
  mints = [];
  answer = async () => [];
  return names;
}

const grants = (
  who: string,
  role: "admin" | "user",
  id: string,
  provider: Provider = "arcade",
) =>
  build(who, role, provider).request(
    `http://openbot.test/api/plugins/servers/${id}/grants`,
  );

afterAll(async () => {
  await database.delete(mcpServers).where(inArray(mcpServers.id, ids));
  await database.$client.close();
});

describe("whose identity is asked about", () => {
  test("a personal app asks upstream as the viewer", async () => {
    const n = await run("personal");
    answer = async () => [
      {
        action: "Gmail.ListEmails",
        state: "authorized",
        scopes: ["a"],
        authorization: "held",
      },
    ];
    const response = await grants(n.viewer, "user", n.id);
    expect(response.status).toBe(200);
    const mine = calls.filter((c) => c.toolkit === n.toolkit);
    expect(mine.map((c) => c.account)).toEqual([
      { holder: "person", userId: n.viewer, vendorUserId: n.viewer },
    ]);
  });

  test("a shared app asks upstream as the app's identity, never the viewer", async () => {
    const n = await run("shared");
    const response = await grants(n.viewer, "admin", n.id);
    expect(response.status).toBe(200);
    const mine = calls.filter((c) => c.toolkit === n.toolkit);
    expect(mine.map((c) => c.account)).toEqual([
      { holder: "deployment", vendorUserId: n.sharedIdentity },
    ]);
    expect(JSON.stringify(mine)).not.toContain(n.viewer);
  });

  test("a non-admin reads a shared app's status (200) but is refused the mint (403)", async () => {
    const n = await run("shared");
    const read = await grants(n.viewer, "user", n.id);
    expect(read.status).toBe(200);
    expect(
      calls.filter((c) => c.toolkit === n.toolkit).map((c) => c.account),
    ).toEqual([{ holder: "deployment", vendorUserId: n.sharedIdentity }]);

    const mint = await build(n.viewer, "user", "arcade").request(
      `http://openbot.test/api/plugins/servers/${n.id}/authorize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "Gmail.ListEmails" }),
      },
    );
    expect(mint.status).toBe(403);
    // Scoped to this case's own app and viewer: nothing was minted or recorded for them.
    expect(mints.filter((t) => t === n.toolkit)).toEqual([]);
    const attempts = await database
      .select()
      .from(pendingAuthorizations)
      .where(inArray(pendingAuthorizations.actorId, [n.viewer]));
    expect(attempts).toEqual([]);
    const trail = await database
      .select()
      .from(auditEvents)
      .where(inArray(auditEvents.targetId, [n.toolkit, n.id]));
    expect(trail.filter((e) => e.eventType.includes("authoriz"))).toEqual([]);
  });
});

describe("what the states say", () => {
  test("blocked only by a deployment secret: needs-operator, naming it", async () => {
    const n = await run("personal");
    answer = async () => [
      {
        action: "Github.ListRepos",
        state: "needs-operator",
        missing: ["GITHUB_SERVER_URL"],
      },
    ];
    const body = (await (await grants(n.viewer, "user", n.id)).json()) as {
      actions: GrantState[];
    };
    expect(body.actions).toEqual([
      {
        action: "Github.ListRepos",
        state: "needs-operator",
        missing: ["GITHUB_SERVER_URL"],
      },
    ]);
  });

  test("blocked by consent: needs-consent carrying its scopes", async () => {
    const n = await run("personal");
    answer = async () => [
      {
        action: "Gmail.SendEmail",
        state: "needs-consent",
        scopes: ["gmail.send"],
      },
    ];
    const body = (await (await grants(n.viewer, "user", n.id)).json()) as {
      actions: GrantState[];
    };
    expect(body.actions).toEqual([
      {
        action: "Gmail.SendEmail",
        state: "needs-consent",
        scopes: ["gmail.send"],
      },
    ]);
  });

  test("a listing that cannot be read is unknown, never needs-consent", async () => {
    const n = await run("personal");
    answer = async () => {
      throw new Error(`vendor said no: token gho_secret_${suite}`);
    };
    const response = await grants(n.viewer, "user", n.id);
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as { actions: GrantState[] };
    expect(body.actions.length).toBeGreaterThan(0);
    for (const entry of body.actions) expect(entry.state).toBe("unknown");
    expect(text).not.toContain("needs-consent");
    expect(text).not.toContain("gho_secret");
  });
});

test("a Composio deployment answers this route successfully", async () => {
  const n = await run("personal", "composio");
  answer = async () => [
    { action: "GMAIL_FETCH", state: "needs-consent", scopes: [] },
  ];
  const response = await grants(n.viewer, "user", n.id, "composio");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    actions: [{ action: "GMAIL_FETCH", state: "needs-consent", scopes: [] }],
  });
  expect(
    calls.filter((c) => c.toolkit === n.toolkit).map((c) => c.account),
  ).toEqual([{ holder: "person", userId: n.viewer, vendorUserId: n.viewer }]);
});
