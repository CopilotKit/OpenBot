// server/tests/app-access-routes.integration.test.ts
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
  teamBotConsents,
  teamBotPublications,
  users,
} from "../src/db/schema";
import type { AppAccess } from "../src/plugins/app-access";
import type { BrokerApp } from "../src/plugins/broker";
import type { AppAccessRequestRecord } from "../src/plugins/plugin-store/app-access";
import { MAX_PENDING_REQUESTS } from "../src/plugins/route-groups/app-access";
import { createPluginRoutes } from "../src/plugins/routes";
import { exposureOf } from "../src/plugins/shared-use";
import { createSharedUseStore } from "../src/plugins/shared-use-store";
import {
  createPluginStore,
  type PluginStore,
  type ServerRecord,
} from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { stubBroker } from "./support/stub-broker";

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
/**
 * Who owns the suite's Bots: nobody the requests below are filed as. A Bot's owner may give it one
 * of their own apps without asking anybody (`owner_grantable`), so a person asking an administrator
 * for a grant is, here, asking about somebody else's Bot. `owner-app-grants.integration.test.ts`
 * covers the owner's side.
 */
const maker = id("maker");
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
    classifiedCount: null,
    permissionCount: null,
    scopedActionCount: null,
    connection: { kind: "consent" },
  },
  {
    slug: slug("gone"),
    name: "Gone App",
    description: "",
    logo: null,
    categories: [],
    actionCount: 1,
    classifiedCount: null,
    permissionCount: null,
    scopedActionCount: null,
    connection: { kind: "consent" },
  },
];

/**
 * The broker, built by `stubBroker`: every member this file does not provide THROWS AND RECORDS,
 * and the check after each test reads the record, so a path that reaches past what is provided is
 * a red even where production catches the throw. Nothing here undoes one account, so
 * `revokeAccount` is not provided rather than stubbed to answer "done" for a revoke that never ran.
 */
const stub = stubBroker({
  // Composio's own declarations: the grant is held here, and there is no authorization flow.
  grantIsLocal: true,
  authorizations: null,
  listApps: async () => directory,
  ensureAuthConfig: async () => "created",
  deleteAuthConfig: async () => {},
  authorize: async () => ({
    redirectUrl: "https://vendor.example/consent",
    authorizationId: null,
  }),
  isConnected: async () => true,
  revoke: async () => true,
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  accountName: async () => "team",
});
const broker = stub.broker;
afterEach(() => {
  stub.expectNothingUnprovidedReached();
});

const enabled: string[] = [];

/**
 * Run before every grant the routes make, when set — how a test holds an approval partway through
 * its change while something else answers the same request.
 */
let beforeGrant: (() => Promise<void>) | null = null;

function storeFor(db = database): PluginStore {
  const real = createPluginStore({
    brokerProvider: "composio",
    database: db,
    auditStore: audit,
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
    deploymentId: `acme-${suite}`,
  });
  return {
    ...real,
    async grant(...args) {
      await beforeGrant?.();
      return real.grant(...args);
    },
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
        effect: "read",
      });
      return { id: `composio-${input.slug}` } as ServerRecord;
    },
  };
}

function appAs(
  actorId: string,
  role: "admin" | "user" = "user",
  options: { composio?: boolean; database?: typeof database } = {},
) {
  const store = storeFor(options.database);
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
  const sharedUse = createSharedUseStore(
    options.database ?? database,
    "composio",
  );
  return new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      store,
      signedIn,
      // Everybody may use the suite's Bot; nobody but an administrator may use the hidden one.
      async (actor, agentId) => agentId !== hidden || actor.role === "admin",
      undefined,
      options.composio === false ? undefined : { broker, provider: "composio" },
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
  /** Each tool's `effect`, by name; a tool left out is unclassified, which reads as a write. */
  effects?: Record<string, "read" | "write">;
  destructive?: string[];
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
      effect: input.effects?.[tool] ?? null,
      destructive: input.destructive?.includes(tool) ?? false,
    });
  if (input.grant !== false)
    await database.insert(pluginGrants).values({
      kind: "mcp",
      ref: `${input.key}/${(input.tools ?? ["READ"])[0]}`,
      agentId: bot,
    });
}

const ourServers = like(mcpServers.id, `%${suite}%`);

/** An administrator's approval of the suite Bot's audience for a Shared app, as granting writes. */
async function approveAudience(serverId: string) {
  const sharedUse = createSharedUseStore(database, "composio");
  await sharedUse.setApproval({
    botId: bot,
    serverId,
    approval: exposureOf(await sharedUse.botFacts(bot)),
    by: admin,
  });
}

async function connectTeamAccount(name: string) {
  await database.insert(brokeredConnections).values({
    provider: "composio",
    app: slug(name),
    holder: "deployment",
    vendorUserId: `openbot-deployment:${suite}`,
    verified: true,
  });
}

async function clearApps() {
  await database
    .delete(teamBotPublications)
    .where(inArray(teamBotPublications.agentId, [bot, hidden]));
  await database
    .delete(teamBotConsents)
    .where(inArray(teamBotConsents.userId, [person, other, admin]));
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
  for (const user of [person, other, admin, maker])
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
      ownerUserId: maker,
      // Public, so the people asking below are in the audience a Shared app's approval covers.
      visibility: agent === bot ? "public" : "private",
      title: "Helper",
      roleDescription: "Helper",
      avatarSeed: "x",
    });
  }
});

beforeEach(async () => {
  events.length = 0;
  enabled.length = 0;
  beforeGrant = null;
  await clearApps();
});

afterAll(async () => {
  await clearApps();
  await database.delete(agents).where(inArray(agents.id, [bot, hidden]));
  await database
    .delete(users)
    .where(inArray(users.id, [person, other, admin, maker]));
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
      vendorUserId: `vendor-${person}`,
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
      vendorUserId: `vendor-${other}`,
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

  test("a Shared app with its team account connected and its audience approved is ready", async () => {
    await seedApp({ key: SLACK, title: "Slack", accountMode: "shared" });
    await approveAudience(SLACK);
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
      effects: { LIST: "read", SEND: "write" },
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
    // The read only: sending is chosen on the Bot's page, never handed out by one press.
    expect(await response.json()).toMatchObject({
      request: { status: "approved", resolvedBy: admin },
      enabled: false,
      granted: [`${SLACK}/LIST`],
    });
    const grants = await database
      .select({ ref: pluginGrants.ref })
      .from(pluginGrants)
      .where(eq(pluginGrants.agentId, bot));
    expect(grants.map((grant) => grant.ref).sort()).toEqual([`${SLACK}/LIST`]);
    const [approval] = await database
      .select()
      .from(sharedUseApprovals)
      .where(eq(sharedUseApprovals.agentId, bot));
    expect(approval?.serverId).toBe(SLACK);
    expect(eventsOf("app_access.approved")[0]?.payload).toMatchObject({
      request: request.id,
      kind: "grant",
      granted: 1,
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
    await approveAudience(SLACK);
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

describe("an administrator's one press on a card", () => {
  const press = (app: string, as = admin, role: "admin" | "user" = "admin") =>
    appAs(as, role).request(
      `/api/plugins/for/${bot}/apps/${encodeURIComponent(app)}/approve`,
      { method: "POST" },
    );

  test("turns an app on and gives it to the Bot, read-only, with the trail two presses leave", async () => {
    const response = await press("Dropbox");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      request: {
        kind: "enable",
        appKey: DROPBOX,
        status: "approved",
        requestedBy: admin,
        resolvedBy: admin,
      },
      enabled: true,
      granted: [`${DROPBOX}/LIST_FILES`],
    });
    expect(enabled).toEqual([slug("dropbox")]);
    expect(eventsOf("app_access.requested")[0]?.payload).toMatchObject({
      app: DROPBOX,
      kind: "enable",
    });
    expect(eventsOf("app_access.approved")[0]?.payload).toMatchObject({
      app: DROPBOX,
      kind: "enable",
      enabled: true,
      granted: 1,
      direct: true,
    });
    const { app } = await json<{ app: AppAccess }>(
      await appAs(person).request(`/api/plugins/for/${bot}/apps/${DROPBOX}`),
    );
    expect(app.state).toBe("not_connected");
  });

  test("gives an app that is on to the Bot, and grants no send", async () => {
    await seedApp({
      key: CALENDAR,
      title: "Google Calendar",
      tools: ["SEND", "LIST"],
      effects: { LIST: "read", SEND: "write" },
      grant: false,
    });
    const response = await press(CALENDAR);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      request: { kind: "grant", status: "approved" },
      enabled: false,
      granted: [`${CALENDAR}/LIST`],
    });
  });

  test("only an administrator may press it, and nothing is filed for anybody else", async () => {
    await seedApp({ key: CALENDAR, title: "Google Calendar", grant: false });
    expect((await press(CALENDAR, person, "user")).status).toBe(403);
    const rows = await database
      .select()
      .from(appAccessRequests)
      .where(eq(appAccessRequests.appKey, CALENDAR));
    expect(rows).toHaveLength(0);
  });

  test("a state with nothing for an administrator to do is refused like a request", async () => {
    await seedApp({ key: GMAIL, title: "Gmail" });
    const response = await press(GMAIL);
    expect(response.status).toBe(409);
    expect(eventsOf("app_access.refused").at(-1)?.payload).toMatchObject({
      reason: "nothing_to_request:not_connected",
    });
  });

  test("a press that cannot be carried out leaves no request waiting", async () => {
    const response = await press("google-drive");
    expect(response.status).toBe(409);
    const { error } = await json<{ error: string }>(response);
    expect(error).toContain("OAuth client");
    // There is no request left to approve again: the admin presses again.
    expect(error).toEndWith("then try again.");
    const rows = await database
      .select({ status: appAccessRequests.status })
      .from(appAccessRequests)
      .where(eq(appAccessRequests.requestedBy, admin));
    expect(rows.map((row) => row.status)).toEqual(["cancelled"]);
    // The trail closes what it opened: filed, refused, then withdrawn.
    const filed = eventsOf("app_access.requested")[0]?.payload as {
      request?: string;
    };
    expect(eventsOf("app_access.cancelled")[0]?.payload).toMatchObject({
      request: filed.request,
      app: "google-drive",
      direct: true,
    });
    expect(eventsOf("app_access.approved")).toHaveLength(0);
  });

  test("a request of theirs already waiting is put back as it was", async () => {
    await appAs(admin, "admin").request(
      "/api/plugins/access-requests",
      post({ agentId: bot, app: "google-drive" }),
    );
    expect((await press("google-drive")).status).toBe(409);
    const rows = await database
      .select({ status: appAccessRequests.status })
      .from(appAccessRequests)
      .where(eq(appAccessRequests.requestedBy, admin));
    expect(rows.map((row) => row.status)).toEqual(["pending"]);
    expect(eventsOf("app_access.cancelled")).toHaveLength(0);
  });
});

/*
 * THE SAME RULE ON AN ARCADE DEPLOYMENT. Which rows are brokered apps, which connections count and
 * which id an app nobody enabled would get all come from the store's broker, so a personal Arcade
 * app reads exactly as a personal Composio app does — under Arcade's case-sensitive toolkit name.
 */
describe("on an Arcade deployment", () => {
  const toolkit = `ArcMail_${suite}`;
  const ARC_MAIL = `arcade-${toolkit}`;
  const docs = `ArcDocs_${suite}`;

  function arcadeStore(): PluginStore {
    return createPluginStore({
      brokerProvider: "arcade",
      database,
      auditStore: audit,
      credentials: {} as never,
      encryptionKey: "x".repeat(44),
      policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
      broker,
      deploymentId: `acme-${suite}`,
    });
  }

  async function seedArcadeApp() {
    await database.insert(mcpServers).values({
      id: ARC_MAIL,
      title: "Arc Mail",
      vendor: "Arcade",
      url: `arcade://${toolkit}`,
      provenance: "arcade",
      authScheme: "OAUTH2",
      accountMode: "personal",
    });
    await database.insert(mcpTools).values({
      serverId: ARC_MAIL,
      name: "READ",
      description: "READ",
      inputSchema: {},
    });
    await database
      .insert(pluginGrants)
      .values({ kind: "mcp", ref: `${ARC_MAIL}/READ`, agentId: bot });
  }

  const forBot = (composioConfigured = true) =>
    arcadeStore().appAccessForBot({
      userId: person,
      agentId: bot,
      composioConfigured,
    });

  test("a personal app is not_connected until the person connects it, then ready", async () => {
    await seedArcadeApp();
    expect(await forBot()).toMatchObject([
      {
        key: ARC_MAIL,
        provider: "arcade",
        account: "personal",
        connect: "consent",
        authScheme: "OAUTH2",
        state: "not_connected",
      },
    ]);
    // Somebody else's connection, and a Composio one at the same app name, are not this person's.
    await database.insert(brokeredConnections).values([
      {
        provider: "arcade",
        app: toolkit,
        holder: "person",
        userId: other,
        vendorUserId: `vendor-${other}`,
        verified: true,
      },
      {
        provider: "composio",
        app: toolkit,
        holder: "person",
        userId: person,
        vendorUserId: `vendor-${person}`,
        verified: true,
      },
    ]);
    expect((await forBot())[0]?.state).toBe("not_connected");
    await database.insert(brokeredConnections).values({
      provider: "arcade",
      app: toolkit,
      holder: "person",
      userId: person,
      vendorUserId: `vendor-${person}`,
      verified: true,
      connectedAt: new Date("2026-10-21T08:00:00.000Z"),
    });
    expect(await forBot()).toMatchObject([
      {
        key: ARC_MAIL,
        state: "ready",
        connectedAt: "2026-10-21T08:00:00.000Z",
      },
    ]);
  });

  test("with no Arcade key the app is switched off at the deployment", async () => {
    await seedArcadeApp();
    const inspected = await arcadeStore().inspectApp({
      app: ARC_MAIL,
      agentId: bot,
      userId: person,
      composioConfigured: false,
    });
    expect(inspected?.unavailable).toBe("composio_unconfigured");
    expect(inspected?.access.state).toBe("disabled");
  });

  test("an app is found by its id or its toolkit name as typed", async () => {
    await seedArcadeApp();
    for (const asked of [ARC_MAIL, toolkit, "arc mail"]) {
      const inspected = await arcadeStore().inspectApp({
        app: asked,
        agentId: bot,
        userId: person,
        composioConfigured: true,
      });
      expect(inspected?.access.key).toBe(ARC_MAIL);
      expect(inspected?.toolkit).toBe(toolkit);
    }
  });

  test("an app only the directory knows is disabled, under the arcade- id enabling would mint", async () => {
    const inspected = await arcadeStore().inspectApp({
      app: "Arc Docs",
      agentId: bot,
      userId: person,
      composioConfigured: true,
      directory: async () => [
        {
          slug: docs,
          name: "Arc Docs",
          description: "",
          logo: null,
          categories: [],
          actionCount: 1,
          classifiedCount: null,
          permissionCount: null,
          scopedActionCount: null,
          connection: { kind: "consent" },
        },
      ],
    });
    expect(inspected?.access).toMatchObject({
      key: `arcade-${docs}`,
      displayName: "Arc Docs",
      provider: "arcade",
      state: "disabled",
      requestKind: "enable",
    });
    expect(inspected?.toolkit).toBe(docs);
  });
});

describe("what approving grants, and when it can be answered", () => {
  async function file(app: string, as = person) {
    const response = await appAs(as).request(
      "/api/plugins/access-requests",
      post({ agentId: bot, app }),
    );
    return (await json<{ request: AppAccessRequestRecord }>(response)).request;
  }
  const statusOf = async (id: string) =>
    (
      await database
        .select({ status: appAccessRequests.status })
        .from(appAccessRequests)
        .where(eq(appAccessRequests.id, id))
    )[0]?.status;

  test("without refs only the read-only actions are granted, never a send or a delete", async () => {
    await seedApp({
      key: GMAIL,
      title: "Gmail",
      tools: ["READ_MAIL", "SEND_MAIL", "DELETE_ALL", "UNLABELLED"],
      effects: { READ_MAIL: "read", SEND_MAIL: "write", DELETE_ALL: "write" },
      destructive: ["DELETE_ALL"],
      grant: false,
    });
    const request = await file("Gmail");
    expect(request.kind).toBe("grant");
    const response = await appAs(admin, "admin").request(
      `/api/plugins/access-requests/${request.id}/approve`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect((await json<{ granted: string[] }>(response)).granted).toEqual([
      `${GMAIL}/READ_MAIL`,
    ]);
    const grants = await database
      .select({ ref: pluginGrants.ref })
      .from(pluginGrants)
      .where(eq(pluginGrants.agentId, bot));
    expect(grants.map((grant) => grant.ref)).toEqual([`${GMAIL}/READ_MAIL`]);
  });

  test("an app with no read-only action is refused with where to choose, and stays pending", async () => {
    await seedApp({
      key: GMAIL,
      title: "Gmail",
      tools: ["SEND_MAIL"],
      effects: { SEND_MAIL: "write" },
      grant: false,
    });
    const request = await file("Gmail");
    const response = await appAs(admin, "admin").request(
      `/api/plugins/access-requests/${request.id}/approve`,
      { method: "POST" },
    );
    expect(response.status).toBe(409);
    expect((await json<{ error: string }>(response)).error).toContain(
      "read-only",
    );
    expect(await statusOf(request.id)).toBe("pending");
    expect(
      await database
        .select()
        .from(pluginGrants)
        .where(eq(pluginGrants.agentId, bot)),
    ).toEqual([]);
    // Naming the actions is how an administrator grants more than the reads.
    const chosen = await appAs(admin, "admin").request(
      `/api/plugins/access-requests/${request.id}/approve`,
      post({ refs: [`${GMAIL}/SEND_MAIL`] }),
    );
    expect(chosen.status).toBe(200);
  });

  for (const [loser, answer] of [
    [
      "a dismissal",
      (id: string) =>
        appAs(admin, "admin").request(
          `/api/plugins/access-requests/${id}/dismiss`,
          { method: "POST" },
        ),
    ],
    [
      "a withdrawal",
      (id: string) =>
        appAs(person).request(`/api/plugins/access-requests/${id}`, {
          method: "DELETE",
        }),
    ],
  ] as const) {
    test(`${loser} arriving while an approval is granting loses to it`, async () => {
      await seedApp({
        key: CALENDAR,
        title: "Google Calendar",
        tools: ["READ"],
        effects: { READ: "read" },
        grant: false,
      });
      const request = await file(CALENDAR);

      let release = () => {};
      let granting = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        granting = resolve;
      });
      beforeGrant = async () => {
        granting();
        await held;
      };
      try {
        const approving = appAs(admin, "admin").request(
          `/api/plugins/access-requests/${request.id}/approve`,
          { method: "POST" },
        );
        await reached;
        // Answered while the grant is still being written: the approval already claimed it.
        const lost = await answer(request.id);
        expect(lost.status).toBe(409);
        release();
        const approved = await approving;
        expect(approved.status).toBe(200);
        expect(await statusOf(request.id)).toBe("approved");
        expect(eventsOf("app_access.approved")).toHaveLength(1);
        expect(eventsOf("app_access.dismissed")).toHaveLength(0);
        expect(eventsOf("app_access.cancelled")).toHaveLength(0);
      } finally {
        release();
        beforeGrant = null;
      }
    });
  }

  test("an approval that throws partway puts the request back", async () => {
    await seedApp({
      key: CALENDAR,
      title: "Google Calendar",
      tools: ["READ"],
      effects: { READ: "read" },
      grant: false,
    });
    const request = await file(CALENDAR);
    beforeGrant = async () => {
      throw new Error("the grant failed");
    };
    const response = await appAs(admin, "admin").request(
      `/api/plugins/access-requests/${request.id}/approve`,
      { method: "POST" },
    );
    expect(response.status).toBe(500);
    expect(await statusOf(request.id)).toBe("pending");
    expect(eventsOf("app_access.approved")).toHaveLength(0);
  });

  test("a request filed again while the first was claimed is the one left waiting", async () => {
    await seedApp({
      key: GMAIL,
      title: "Gmail",
      tools: ["SEND_MAIL"],
      effects: { SEND_MAIL: "write" },
      grant: false,
    });
    const first = await file("Gmail");
    const store = storeFor();
    expect(
      await store.claimAppAccessRequest({ id: first.id, by: admin }),
    ).not.toBeNull();
    const second = await file("Gmail");
    expect(second.id).not.toBe(first.id);
    await store.releaseAppAccessRequest({ id: first.id, by: admin });
    expect(await statusOf(first.id)).toBe("cancelled");
    expect(await statusOf(second.id)).toBe("pending");
  });
});

describe("what a request may carry", () => {
  const ask = (app: string, agentId = bot) =>
    appAs(person).request(
      "/api/plugins/access-requests",
      post({ agentId, app }),
    );

  test("an app or Bot name past the cap is refused before anything is read or written", async () => {
    const long = "x".repeat(201);
    expect((await ask(`composio-${long}`)).status).toBe(400);
    expect((await ask(GMAIL, long)).status).toBe(400);
    expect(eventsOf("app_access.refused")).toEqual([]);
    expect(
      (await appAs(person).request(`/api/plugins/for/${bot}/apps/${long}`))
        .status,
    ).toBe(404);
  });

  test("enabling a composio- id the directory does not list is no such app", async () => {
    const response = await ask(row("invented"));
    expect(response.status).toBe(404);
    const filed = await database
      .select()
      .from(appAccessRequests)
      .where(eq(appAccessRequests.requestedBy, person));
    expect(filed).toEqual([]);
  });

  test("a grant that outlived its app can still be asked about", async () => {
    await database
      .insert(pluginGrants)
      .values({ kind: "mcp", ref: `${GONE}/SEND`, agentId: bot });
    const response = await appAs(person, "user", { composio: false }).request(
      "/api/plugins/access-requests",
      post({ agentId: bot, app: GONE }),
    );
    expect(response.status).toBe(201);
  });

  test(`at ${MAX_PENDING_REQUESTS} waiting a new one is refused, and one already waiting is still shown`, async () => {
    await database.insert(appAccessRequests).values(
      Array.from({ length: MAX_PENDING_REQUESTS - 1 }, (_, index) => ({
        id: randomUUID(),
        requestedBy: person,
        agentId: bot,
        appKey: `composio-filler${index}_${suite}`,
        appTitle: `Filler ${index}`,
        kind: "enable" as const,
      })),
    );
    await seedApp({ key: CALENDAR, title: "Google Calendar", grant: false });
    const last = await ask(CALENDAR);
    expect(last.status).toBe(201);
    const over = await ask("Dropbox");
    expect(over.status).toBe(429);
    expect(eventsOf("app_access.refused").at(-1)?.payload).toMatchObject({
      reason: "too_many_pending",
    });
    const again = await ask(CALENDAR);
    expect(again.status).toBe(200);
    expect((await json<{ created: boolean }>(again)).created).toBe(false);
  });
});

describe("finding an app by its name", () => {
  test("a name finds the enabled app before a catalogue entry nobody added", async () => {
    const DRIVE = row("googledrive");
    await seedApp({ key: DRIVE, title: "Google Drive", grant: false });
    const { app } = await json<{ app: AppAccess }>(
      await appAs(person).request(
        `/api/plugins/for/${bot}/apps/Google%20Drive`,
      ),
    );
    expect(app).toMatchObject({
      key: DRIVE,
      state: "not_granted",
      requestKind: "grant",
    });
    // The entry is still what its own key names.
    const { app: entry } = await json<{ app: AppAccess }>(
      await appAs(person).request(`/api/plugins/for/${bot}/apps/google-drive`),
    );
    expect(entry).toMatchObject({ key: "google-drive", state: "disabled" });
  });

  test("of two enabled apps with one name, the one this Bot holds", async () => {
    await seedApp({ key: row("drive_a"), title: "Drive", grant: false });
    await seedApp({ key: row("drive_b"), title: "Drive" });
    const { app } = await json<{ app: AppAccess }>(
      await appAs(person).request(`/api/plugins/for/${bot}/apps/Drive`),
    );
    expect(app.key).toBe(row("drive_b"));
  });
});

describe("why an app is off, and a Shared app's audience", () => {
  test("a switched-off app says why", async () => {
    await seedApp({ key: GMAIL, title: "Gmail" });
    const { app } = await json<{ app: AppAccess }>(
      await appAs(person, "user", { composio: false }).request(
        `/api/plugins/for/${bot}/apps/${GMAIL}`,
      ),
    );
    expect(app).toMatchObject({
      state: "disabled",
      unavailable: "composio_unconfigured",
    });
    const { app: ready } = await json<{ app: AppAccess }>(
      await appAs(person).request(`/api/plugins/for/${bot}/apps/${GMAIL}`),
    );
    expect(ready.unavailable).toBeNull();
  });

  test("a Shared app whose audience nobody approved is refused, with nothing to file", async () => {
    await seedApp({ key: SLACK, title: "Slack", accountMode: "shared" });
    await connectTeamAccount("slack");
    const { app } = await json<{ app: AppAccess }>(
      await appAs(person).request(`/api/plugins/for/${bot}/apps/${SLACK}`),
    );
    expect(app).toMatchObject({
      state: "shared_not_approved",
      requestKind: null,
    });
    const filed = await appAs(person).request(
      "/api/plugins/access-requests",
      post({ agentId: bot, app: SLACK }),
    );
    expect(filed.status).toBe(409);
    await approveAudience(SLACK);
    const { app: approved } = await json<{ app: AppAccess }>(
      await appAs(person).request(`/api/plugins/for/${bot}/apps/${SLACK}`),
    );
    expect(approved.state).toBe("ready");
  });
});

describe("a teammate on somebody else's Team Bot", () => {
  beforeEach(async () => {
    await database
      .insert(teamBotPublications)
      .values({ agentId: bot, publishedBy: maker, audience: "team" });
    await seedApp({ key: GMAIL, title: "Gmail" });
  });
  const connect = (
    userId: string,
    over: { verified?: boolean; probeAction?: string } = {},
  ) =>
    database.insert(brokeredConnections).values({
      provider: "composio",
      app: slug("gmail"),
      holder: "person",
      userId,
      vendorUserId: `vendor-${userId}`,
      verified: over.verified ?? true,
      ...(over.probeAction ? { probeAction: over.probeAction } : {}),
    });
  const asTeammate = async () =>
    (
      await json<{ app: AppAccess }>(
        await appAs(other).request(`/api/plugins/for/${bot}/apps/${GMAIL}`),
      )
    ).app;

  test("the owner's connection is the one their calls use", async () => {
    await connect(maker);
    expect(await asTeammate()).toMatchObject({
      state: "ready",
      accountHolder: "owner",
      asksFirst: false,
    });
  });

  test("the owner's refused connection is theirs to reconnect, not the teammate's", async () => {
    await connect(maker, { verified: false, probeAction: "GMAIL_LIST" });
    await connect(other);
    expect(await asTeammate()).toMatchObject({
      state: "reconnect",
      accountHolder: "owner",
      requestKind: null,
    });
  });

  test("with no owner account, the teammate's own, asked first until they always allow it", async () => {
    expect(await asTeammate()).toMatchObject({
      state: "not_connected",
      accountHolder: "you",
    });
    await connect(other);
    expect(await asTeammate()).toMatchObject({
      state: "ready",
      accountHolder: "you",
      asksFirst: true,
    });
    await database.insert(teamBotConsents).values({
      userId: other,
      agentId: bot,
      serverId: GMAIL,
      decision: "always",
    });
    expect((await asTeammate()).asksFirst).toBe(false);
  });

  test("the owner reads their own account, and is never asked", async () => {
    await connect(maker);
    const { app } = await json<{ app: AppAccess }>(
      await appAs(maker).request(`/api/plugins/for/${bot}/apps/${GMAIL}`),
    );
    expect(app).toMatchObject({
      state: "ready",
      accountHolder: "you",
      asksFirst: false,
    });
  });
});

afterAll(async () => {
  await database.$client.close();
});
