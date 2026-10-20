// server/tests/app-access-routes.integration.test.ts
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  appAccessRequests,
  brokeredConnections,
  credentials,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pluginGrants,
  sharedUseApprovals,
  users,
} from "../src/db/schema";
import type { AppAccess } from "../src/plugins/app-access";
import type { BrokerApp, ConnectedAppBroker } from "../src/plugins/broker";
import type { AppAccessRequestRecord } from "../src/plugins/plugin-store/app-access";
import { createPluginRoutes } from "../src/plugins/routes";
import { createSharedUseStore } from "../src/plugins/shared-use-store";
import {
  createPluginStore,
  type PluginStore,
  type ServerRecord,
} from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * What a work app is for one person on one Bot, the requests they file when only an administrator
 * can change it, and what approving one does — against the real tables, through the real routes.
 *
 * The vendor is the one thing faked. `addBrokeredApp` refreshes an app's tools from Composio
 * itself, which no test can reach, so the store's enable is replaced with one that writes the row
 * and a tool the way the real one ends; everything around it — the directory check, the grant, the
 * Shared approval, the conditional close, the trail — is the shipped code.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `${name}-${suite}`;

const person = id("person");
const other = id("other");
const admin = id("admin");
const bot = id("bot");
const hidden = id("hidden");

/** A Composio slug for this suite, and the row id `addBrokeredApp` would give it. */
const slug = (name: string) => `${name}_${suite}`;
const row = (name: string) => `composio-${slug(name)}`;

const GMAIL = row("gmail");
const SLACK = row("slack");
const LINEAR = row("linear");
const NEWS = row("news");
const CALENDAR = row("calendar");
const GONE = row("gone");
const DROPBOX = row("dropbox");

const events: AuditEventInput[] = [];
const audit: AuditStore = {
  insert: async (event) => {
    events.push(event);
  },
};
const eventsOf = (type: string) =>
  events.filter((event) => event.eventType === type);

const directory: BrokerApp[] = [
  {
    slug: slug("dropbox"),
    name: "Dropbox",
    description: "Files",
    logo: null,
    categories: [],
    actionCount: 1,
    connection: { kind: "consent" },
  },
  {
    slug: slug("gone"),
    name: "Gone App",
    description: "",
    logo: null,
    categories: [],
    actionCount: 1,
    connection: { kind: "consent" },
  },
];

const broker: ConnectedAppBroker = {
  listApps: async () => directory,
  ensureAuthConfig: async () => "created",
  deleteAuthConfig: async () => {},
  authorize: async () => ({ redirectUrl: "https://vendor.example/consent" }),
  isConnected: async () => true,
  revoke: async () => true,
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => "team",
};

const enabled: string[] = [];

function storeFor(): PluginStore {
  const real = createPluginStore({
    database,
    auditStore: audit,
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
    deploymentId: `acme-${suite}`,
  });
  return {
    ...real,
    async addBrokeredApp(input) {
      enabled.push(input.slug);
      await database.insert(mcpServers).values({
        id: `composio-${input.slug}`,
        title: input.title,
        vendor: "Composio",
        url: `composio://${input.slug}`,
        provenance: "composio",
        authScheme: "OAUTH2",
        accountMode: "personal",
      });
      await database.insert(mcpTools).values({
        serverId: `composio-${input.slug}`,
        name: "LIST_FILES",
        description: "List files",
        inputSchema: {},
      });
      return { id: `composio-${input.slug}` } as ServerRecord;
    },
  };
}

function appAs(
  actorId: string,
  role: "admin" | "user" = "user",
  options: { composio?: boolean } = {},
) {
  const store = storeFor();
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actorId,
      email: `${actorId}@example.test`,
      role,
    } as never);
    await next();
  };
  const sharedUse = createSharedUseStore(database);
  return new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      store,
      signedIn,
      // Everybody may use the suite's Bot; nobody but an administrator may use the hidden one.
      async (actor, agentId) => agentId !== hidden || actor.role === "admin",
      undefined,
      options.composio === false ? undefined : { broker },
      { modes: {} as never, use: sharedUse },
    ),
  );
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function seedApp(input: {
  key: string;
  title: string;
  toolkit?: string;
  authScheme?: string | null;
  accountMode?: "personal" | "shared" | null;
  tools?: string[];
  grant?: boolean;
}) {
  await database.insert(mcpServers).values({
    id: input.key,
    title: input.title,
    vendor: "Composio",
    url: `composio://${input.toolkit ?? input.key.replace(/^composio-/, "")}`,
    provenance: "composio",
    authScheme: input.authScheme === undefined ? "OAUTH2" : input.authScheme,
    accountMode:
      input.accountMode === undefined ? "personal" : input.accountMode,
    sharedVendorUserId:
      input.accountMode === "shared" ? `openbot-deployment:${suite}` : null,
  });
  for (const tool of input.tools ?? ["READ"])
    await database.insert(mcpTools).values({
      serverId: input.key,
      name: tool,
      description: tool,
      inputSchema: {},
    });
  if (input.grant !== false)
    await database.insert(pluginGrants).values({
      kind: "mcp",
      ref: `${input.key}/${(input.tools ?? ["READ"])[0]}`,
      agentId: bot,
    });
}

const ourServers = like(mcpServers.id, `%${suite}%`);

async function clearApps() {
  await database
    .delete(appAccessRequests)
    .where(inArray(appAccessRequests.requestedBy, [person, other, admin]));
  await database
    .delete(pluginGrants)
    .where(inArray(pluginGrants.agentId, [bot, hidden]));
  await database
    .delete(brokeredConnections)
    .where(like(brokeredConnections.app, `%${suite}%`));
  await database
    .delete(sharedUseApprovals)
    .where(eq(sharedUseApprovals.agentId, bot));
  await database.delete(mcpServers).where(ourServers);
  await database
    .delete(mcpUserCredentials)
    .where(eq(mcpUserCredentials.serverId, "google-drive"));
  await database.delete(mcpServers).where(eq(mcpServers.id, "google-drive"));
  await database
    .delete(credentials)
    .where(eq(credentials.provider, `google-drive-${suite}`));
}

beforeAll(async () => {
  for (const user of [person, other, admin])
    await database.insert(users).values({
      id: user,
      email: `${user}@example.test`,
      name: user,
      emailVerified: true,
    });
  for (const agent of [bot, hidden]) {
    await database.insert(agents).values({
      id: agent,
      name: `Bot ${agent}`,
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: agent,
      ownerUserId: person,
      visibility: "private",
      title: "Helper",
      roleDescription: "Helper",
      avatarSeed: "x",
    });
  }
});

beforeEach(async () => {
  events.length = 0;
  enabled.length = 0;
  await clearApps();
});

afterAll(async () => {
  await clearApps();
  await database.delete(agents).where(inArray(agents.id, [bot, hidden]));
  await database.delete(users).where(inArray(users.id, [person, other, admin]));
});

describe("what each app a Bot holds is, for the person asking", () => {
  test("every state a held app can be in, named by the app's own name", async () => {
    await seedApp({ key: GMAIL, title: "Gmail" });
    await seedApp({ key: SLACK, title: "Slack", accountMode: "shared" });
    await seedApp({ key: LINEAR, title: "Linear", authScheme: "API_KEY" });
    await seedApp({
      key: NEWS,
      title: "Hacker News",
      authScheme: "NO_AUTH",
      accountMode: null,
    });
    await seedApp({ key: CALENDAR, title: "Google Calendar", grant: false });
    // A grant whose app is gone: still something this Bot was given.
    await database
      .insert(pluginGrants)
      .values({ kind: "mcp", ref: `${GONE}/SEND`, agentId: bot });
    // Linear connected, and its key refused by the vendor at the last check.
    await database.insert(brokeredConnections).values({
      provider: "composio",
      app: slug("linear"),
      holder: "person",
      userId: person,
      vendorUserId: person,
      verified: false,
      probeAction: "LINEAR_LIST",
    });

    const response = await appAs(person).request(
      `/api/plugins/for/${bot}/apps`,
    );
    expect(response.status).toBe(200);
    const { apps } = await json<{ apps: AppAccess[] }>(response);
    const byKey = new Map(apps.map((app) => [app.key, app]));

    expect(byKey.get(GMAIL)).toMatchObject({
      displayName: "Gmail",
      state: "not_connected",
      account: "personal",
      connect: "consent",
      requestKind: null,
      granted: true,
    });
    expect(byKey.get(SLACK)).toMatchObject({
      state: "shared_not_connected",
      account: "shared",
      requestKind: "connect_shared",
    });
    expect(byKey.get(LINEAR)).toMatchObject({
      state: "reconnect",
      connect: "key",
    });
    expect(byKey.get(NEWS)).toMatchObject({
      state: "ready",
      account: "deployment",
    });
    expect(byKey.get(GONE)).toMatchObject({
      displayName: "Gone App",
      state: "disabled",
      requestKind: "enable",
    });
    // Not held, so not on the Bot's list.
    expect(byKey.has(CALENDAR)).toBe(false);
    // Sorted by name.
    expect(apps.map((app) => app.displayName)).toEqual(
      [...apps.map((app) => app.displayName)].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
  });

  test("a usable connection is ready, and somebody else's is not mine", async () => {
    await seedApp({ key: GMAIL, title: "Gmail" });
    await database.insert(brokeredConnections).values({
      provider: "composio",
      app: slug("gmail"),
      holder: "person",
      userId: other,
      vendorUserId: other,
      verified: true,
      connectedAt: new Date("2026-10-20T12:00:00.000Z"),
    });
    const mine = await json<{ apps: AppAccess[] }>(
      await appAs(person).request(`/api/plugins/for/${bot}/apps`),
    );
    expect(mine.apps[0]?.state).toBe("not_connected");
    // Nothing of theirs leaks into mine, not even when they connected.
    expect(mine.apps[0]?.connectedAt).toBeNull();
    const theirs = await json<{ apps: AppAccess[] }>(
      await appAs(other).request(`/api/plugins/for/${bot}/apps`),
    );
    expect(theirs.apps[0]?.state).toBe("ready");
    // When, so a chat card over a lost account can tell a reconnection from the loss.
    expect(theirs.apps[0]?.connectedAt).toBe("2026-10-20T12:00:00.000Z");
  });

  test("a Shared app with its team account connected is ready for everybody", async () => {
    await seedApp({ key: SLACK, title: "Slack", accountMode: "shared" });
    await database.insert(brokeredConnections).values({
      provider: "composio",
      app: slug("slack"),
      holder: "deployment",
      vendorUserId: `openbot-deployment:${suite}`,
      verified: true,
      connectedAt: new Date("2026-10-20T09:30:00.000Z"),
    });
    const { apps } = await json<{ apps: AppAccess[] }>(
      await appAs(person).request(`/api/plugins/for/${bot}/apps`),
    );
    expect(apps[0]?.state).toBe("ready");
    // The team account's, since that is the account the app runs in for everybody.
    expect(apps[0]?.connectedAt).toBe("2026-10-20T09:30:00.000Z");
  });

  test("with no Composio key every Composio app is switched off", async () => {
    await seedApp({ key: GMAIL, title: "Gmail" });
    const { apps } = await json<{ apps: AppAccess[] }>(
      await appAs(person, "user", { composio: false }).request(
        `/api/plugins/for/${bot}/apps`,
      ),
    );
    expect(apps[0]).toMatchObject({ state: "disabled", requestKind: "enable" });
  });

  test("a Bot the person cannot use answers 404", async () => {
    const response = await appAs(person).request(
      `/api/plugins/for/${hidden}/apps`,
    );
    expect(response.status).toBe(404);
  });

  test("a per-person catalogue app reads its credential, withdrawn or not", async () => {
    const [client] = await database
      .insert(credentials)
      .values({
        kind: "mcp_oauth_client",
        provider: `google-drive-${suite}`,
        keyId: "oauth-client",
        metadata: {},
        encryptedValue: "sealed",
      })
      .returning({ id: credentials.id });
    await database.insert(mcpServers).values({
      id: "google-drive",
      title: "Google Drive",
      vendor: "Google",
      url: "https://www.googleapis.com/drive/v3",
      provenance: "first-party",
      credentialId: client?.id ?? null,
    });
    await database
      .insert(pluginGrants)
      .values({ kind: "mcp", ref: "google-drive/search", agentId: bot });
    const [credential] = await database
      .insert(credentials)
      .values({
        kind: "mcp_user_token",
        provider: `google-drive-${suite}`,
        keyId: person,
        metadata: {},
        encryptedValue: "sealed",
        revokedAt: new Date(),
      })
      .returning({ id: credentials.id });
    if (!credential) throw new Error("credential not stored");
    await database.insert(mcpUserCredentials).values({
      serverId: "google-drive",
      userId: person,
      credentialId: credential.id,
      scope: "drive.readonly",
    });
    const { apps } = await json<{ apps: AppAccess[] }>(
      await appAs(person).request(`/api/plugins/for/${bot}/apps`),
    );
    expect(apps[0]).toMatchObject({
      key: "google-drive",
      displayName: "Google Drive",
      provider: "catalogue",
      connect: "oauth",
      state: "reconnect",
    });
  });
});

describe("one app, by key or by name, held or not", () => {
  test("an enabled app the Bot does not hold is not_granted, found by its name", async () => {
    await seedApp({ key: CALENDAR, title: "Google Calendar", grant: false });
    for (const asked of [CALENDAR, slug("calendar"), "google calendar"]) {
      const response = await appAs(person).request(
        `/api/plugins/for/${bot}/apps/${encodeURIComponent(asked)}`,
      );
      expect(response.status).toBe(200);
      expect((await json<{ app: AppAccess }>(response)).app).toMatchObject({
        key: CALENDAR,
        state: "not_granted",
        requestKind: "grant",
      });
    }
  });

  test("an app only the directory knows is disabled, under the id enabling would mint", async () => {
    const response = await appAs(person).request(
      `/api/plugins/for/${bot}/apps/Dropbox`,
    );
    expect((await json<{ app: AppAccess }>(response)).app).toMatchObject({
      key: DROPBOX,
      displayName: "Dropbox",
      provider: "composio",
      state: "disabled",
      requestKind: "enable",
    });
  });

  test("a catalogue entry nobody added is disabled under its key", async () => {
    const response = await appAs(person).request(
      `/api/plugins/for/${bot}/apps/notion`,
    );
    expect((await json<{ app: AppAccess }>(response)).app).toMatchObject({
      key: "notion",
      displayName: "Notion",
      provider: "catalogue",
      state: "disabled",
    });
  });

  test("a word that names no app is 404", async () => {
    const response = await appAs(person).request(
      `/api/plugins/for/${bot}/apps/${encodeURIComponent("Not An App")}`,
    );
    expect(response.status).toBe(404);
  });
});

describe("asking for access", () => {
  test("files the kind the state needs, once, and the status shows it", async () => {
    await seedApp({ key: CALENDAR, title: "Google Calendar", grant: false });
    const first = await appAs(person).request(
      "/api/plugins/access-requests",
      post({ agentId: bot, app: "Google Calendar" }),
    );
    expect(first.status).toBe(201);
    const filed = await json<{
      request: AppAccessRequestRecord;
      created: boolean;
    }>(first);
    expect(filed).toMatchObject({
      created: true,
      request: {
        appKey: CALENDAR,
        appTitle: "Google Calendar",
        kind: "grant",
        status: "pending",
        agentId: bot,
        requestedBy: person,
      },
    });

    const again = await appAs(person).request(
      "/api/plugins/access-requests",
      post({ agentId: bot, app: CALENDAR }),
    );
    expect(again.status).toBe(200);
    expect(
      await json<{ request: { id: string }; created: boolean }>(again),
    ).toMatchObject({
      created: false,
      request: { id: filed.request.id },
    });
    expect(eventsOf("app_access.requested")).toHaveLength(1);

    const status = await json<{ app: AppAccess }>(
      await appAs(person).request(`/api/plugins/for/${bot}/apps/${CALENDAR}`),
    );
    expect(status.app.request).toMatchObject({
      id: filed.request.id,
      kind: "grant",
    });
    // Somebody else asking files their own.
    const theirs = await appAs(other).request(
      "/api/plugins/access-requests",
      post({ agentId: bot, app: CALENDAR }),
    );
    expect(theirs.status).toBe(201);
  });

  test("two presses at once still leave one pending request", async () => {
    await seedApp({ key: CALENDAR, title: "Google Calendar", grant: false });
    const responses = await Promise.all(
      [1, 2, 3].map(() =>
        appAs(person).request(
          "/api/plugins/access-requests",
          post({ agentId: bot, app: CALENDAR }),
        ),
      ),
    );
    const ids = new Set(
      await Promise.all(
        responses.map(
          async (response) =>
            (await json<{ request: { id: string } }>(response)).request.id,
        ),
      ),
    );
    expect(ids.size).toBe(1);
    const rows = await database
      .select()
      .from(appAccessRequests)
      .where(
        and(
          eq(appAccessRequests.requestedBy, person),
          eq(appAccessRequests.status, "pending"),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  test("a state the person can fix themselves is refused, and the refusal is in the trail", async () => {
    await seedApp({ key: GMAIL, title: "Gmail" });
    const response = await appAs(person).request(
      "/api/plugins/access-requests",
      post({ agentId: bot, app: GMAIL }),
    );
    expect(response.status).toBe(409);
    expect(eventsOf("app_access.refused")[0]?.payload).toMatchObject({
      app: GMAIL,
      reason: "nothing_to_request:not_connected",
    });
  });

  test("a Bot the person cannot use, and an unknown app, are refused and recorded", async () => {
    const hiddenBot = await appAs(person).request(
      "/api/plugins/access-requests",
      post({ agentId: hidden, app: "Dropbox" }),
    );
    expect(hiddenBot.status).toBe(404);
    const unknown = await appAs(person).request(
      "/api/plugins/access-requests",
      post({ agentId: bot, app: "Not An App" }),
    );
    expect(unknown.status).toBe(404);
    expect(
      eventsOf("app_access.refused").map((event) => event.payload.reason),
    ).toEqual(["no_such_bot", "no_such_app"]);
    const malformed = await appAs(person).request(
      "/api/plugins/access-requests",
      post({ agentId: 7 }),
    );
    expect(malformed.status).toBe(400);
  });

  test("a person lists and cancels their own, and cannot touch anybody else's", async () => {
    await seedApp({ key: CALENDAR, title: "Google Calendar", grant: false });
    const { request } = await json<{ request: AppAccessRequestRecord }>(
      await appAs(person).request(
        "/api/plugins/access-requests",
        post({ agentId: bot, app: CALENDAR }),
      ),
    );
    const mine = await json<{ requests: AppAccessRequestRecord[] }>(
      await appAs(person).request("/api/plugins/access-requests/mine"),
    );
    expect(mine.requests.map((row) => row.id)).toEqual([request.id]);
    expect(
      (
        await json<{ requests: AppAccessRequestRecord[] }>(
          await appAs(other).request("/api/plugins/access-requests/mine"),
        )
      ).requests,
    ).toEqual([]);

    const notTheirs = await appAs(other).request(
      `/api/plugins/access-requests/${request.id}`,
      { method: "DELETE" },
    );
    expect(notTheirs.status).toBe(404);

    const cancelled = await appAs(person).request(
      `/api/plugins/access-requests/${request.id}`,
      { method: "DELETE" },
    );
    expect(cancelled.status).toBe(200);
    expect(
      (await json<{ request: AppAccessRequestRecord }>(cancelled)).request,
    ).toMatchObject({ status: "cancelled", resolvedBy: person });
    expect(eventsOf("app_access.cancelled")).toHaveLength(1);

    const twice = await appAs(person).request(
      `/api/plugins/access-requests/${request.id}`,
      { method: "DELETE" },
    );
    expect(twice.status).toBe(409);
  });
});

describe("answering a request", () => {
  async function file(app: string, as = person) {
    const response = await appAs(as).request(
      "/api/plugins/access-requests",
      post({ agentId: bot, app }),
    );
    return (await json<{ request: AppAccessRequestRecord }>(response)).request;
  }

  test("only an administrator sees the inbox and its counts", async () => {
    await seedApp({ key: CALENDAR, title: "Google Calendar", grant: false });
    await file(CALENDAR);
    await file(CALENDAR, other);
    await file("Dropbox");

    expect(
      (await appAs(person).request("/api/plugins/access-requests")).status,
    ).toBe(403);
    const inbox = await json<{
      requests: AppAccessRequestRecord[];
      counts: { total: number; byApp: Record<string, number> };
    }>(
      await appAs(admin, "admin").request(
        `/api/plugins/access-requests?app=${CALENDAR}`,
      ),
    );
    expect(inbox.requests).toHaveLength(2);
    expect(inbox.requests[0]).toMatchObject({
      botName: `Bot ${bot}`,
      requesterEmail: expect.stringContaining("@example.test"),
    });
    expect(inbox.counts.byApp[CALENDAR]).toBe(2);
    expect(inbox.counts.byApp[DROPBOX]).toBe(1);
    expect(inbox.counts.total).toBeGreaterThanOrEqual(3);
  });

  test("approving a grant request grants the app's tools and records the Shared approval", async () => {
    await seedApp({
      key: SLACK,
      title: "Slack",
      accountMode: "shared",
      tools: ["SEND", "LIST"],
      grant: false,
    });
    const request = await file(SLACK);
    expect(request.kind).toBe("grant");

    expect(
      (
        await appAs(person).request(
          `/api/plugins/access-requests/${request.id}/approve`,
          { method: "POST" },
        )
      ).status,
    ).toBe(403);

    const response = await appAs(admin, "admin").request(
      `/api/plugins/access-requests/${request.id}/approve`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      request: { status: "approved", resolvedBy: admin },
      enabled: false,
      granted: [`${SLACK}/LIST`, `${SLACK}/SEND`],
    });
    const grants = await database
      .select({ ref: pluginGrants.ref })
      .from(pluginGrants)
      .where(eq(pluginGrants.agentId, bot));
    expect(grants.map((grant) => grant.ref).sort()).toEqual([
      `${SLACK}/LIST`,
      `${SLACK}/SEND`,
    ]);
    const [approval] = await database
      .select()
      .from(sharedUseApprovals)
      .where(eq(sharedUseApprovals.agentId, bot));
    expect(approval?.serverId).toBe(SLACK);
    expect(eventsOf("app_access.approved")[0]?.payload).toMatchObject({
      request: request.id,
      kind: "grant",
      granted: 2,
    });

    // The person now sees the next step, which is not theirs to ask for.
    const { app } = await json<{ app: AppAccess }>(
      await appAs(person).request(`/api/plugins/for/${bot}/apps/${SLACK}`),
    );
    expect(app).toMatchObject({ state: "shared_not_connected", request: null });

    const twice = await appAs(admin, "admin").request(
      `/api/plugins/access-requests/${request.id}/approve`,
      { method: "POST" },
    );
    expect(twice.status).toBe(409);
  });

  test("`refs` narrows the grant, and a ref outside the app is refused", async () => {
    await seedApp({
      key: CALENDAR,
      title: "Google Calendar",
      tools: ["READ", "WRITE"],
      grant: false,
    });
    const request = await file(CALENDAR);
    const outside = await appAs(admin, "admin").request(
      `/api/plugins/access-requests/${request.id}/approve`,
      post({ refs: [`${GMAIL}/READ`] }),
    );
    expect(outside.status).toBe(400);
    expect(eventsOf("app_access.refused").at(-1)?.payload).toMatchObject({
      reason: "refs_outside_app",
      request: request.id,
    });
    const narrowed = await appAs(admin, "admin").request(
      `/api/plugins/access-requests/${request.id}/approve`,
      post({ refs: [`${CALENDAR}/READ`] }),
    );
    expect(narrowed.status).toBe(200);
    expect((await json<{ granted: string[] }>(narrowed)).granted).toEqual([
      `${CALENDAR}/READ`,
    ]);
  });

  test("approving an enable request switches the app on and grants it to the Bot", async () => {
    const request = await file("Dropbox");
    expect(request).toMatchObject({ kind: "enable", appKey: DROPBOX });
    const response = await appAs(admin, "admin").request(
      `/api/plugins/access-requests/${request.id}/approve`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      enabled: true,
      granted: [`${DROPBOX}/LIST_FILES`],
    });
    expect(enabled).toEqual([slug("dropbox")]);
    const { app } = await json<{ app: AppAccess }>(
      await appAs(person).request(`/api/plugins/for/${bot}/apps/${DROPBOX}`),
    );
    expect(app).toMatchObject({
      state: "not_connected",
      displayName: "Dropbox",
    });
  });

  test("an app that needs what only an administrator can type stays pending", async () => {
    const request = await file("google-drive");
    expect(request.kind).toBe("enable");
    const response = await appAs(admin, "admin").request(
      `/api/plugins/access-requests/${request.id}/approve`,
      { method: "POST" },
    );
    expect(response.status).toBe(409);
    expect((await json<{ error: string }>(response)).error).toContain(
      "OAuth client",
    );
    const [row] = await database
      .select({ status: appAccessRequests.status })
      .from(appAccessRequests)
      .where(eq(appAccessRequests.id, request.id));
    expect(row?.status).toBe("pending");
    expect(eventsOf("app_access.refused").at(-1)?.payload).toMatchObject({
      reason: "needs_admin_input",
    });
  });

  test("with no Composio key an enable request is refused with the setting to change", async () => {
    await seedApp({ key: GMAIL, title: "Gmail" });
    const response = await appAs(person, "user", { composio: false }).request(
      "/api/plugins/access-requests",
      post({ agentId: bot, app: GMAIL }),
    );
    const { request } = await json<{ request: AppAccessRequestRecord }>(
      response,
    );
    expect(request.kind).toBe("enable");
    const approve = await appAs(admin, "admin", { composio: false }).request(
      `/api/plugins/access-requests/${request.id}/approve`,
      { method: "POST" },
    );
    expect(approve.status).toBe(503);
    expect((await json<{ error: string }>(approve)).error).toContain(
      "COMPOSIO_API_KEY",
    );
  });

  test("a team-account request is approved only once the account is connected", async () => {
    await seedApp({ key: SLACK, title: "Slack", accountMode: "shared" });
    const request = await file(SLACK);
    expect(request.kind).toBe("connect_shared");
    const early = await appAs(admin, "admin").request(
      `/api/plugins/access-requests/${request.id}/approve`,
      { method: "POST" },
    );
    expect(early.status).toBe(409);
    await database.insert(brokeredConnections).values({
      provider: "composio",
      app: slug("slack"),
      holder: "deployment",
      vendorUserId: `openbot-deployment:${suite}`,
      verified: true,
    });
    const later = await appAs(admin, "admin").request(
      `/api/plugins/access-requests/${request.id}/approve`,
      { method: "POST" },
    );
    expect(later.status).toBe(200);
    const { app } = await json<{ app: AppAccess }>(
      await appAs(person).request(`/api/plugins/for/${bot}/apps/${SLACK}`),
    );
    expect(app.state).toBe("ready");
  });

  test("dismissing changes nothing but the request", async () => {
    await seedApp({ key: CALENDAR, title: "Google Calendar", grant: false });
    const request = await file(CALENDAR);
    const response = await appAs(admin, "admin").request(
      `/api/plugins/access-requests/${request.id}/dismiss`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(
      (await json<{ request: AppAccessRequestRecord }>(response)).request,
    ).toMatchObject({ status: "dismissed", resolvedBy: admin });
    expect(eventsOf("app_access.dismissed")).toHaveLength(1);
    const { app } = await json<{ app: AppAccess }>(
      await appAs(person).request(`/api/plugins/for/${bot}/apps/${CALENDAR}`),
    );
    expect(app).toMatchObject({ state: "not_granted", request: null });
    const again = await appAs(admin, "admin").request(
      `/api/plugins/access-requests/${request.id}/dismiss`,
      { method: "POST" },
    );
    expect(again.status).toBe(409);
  });
});
