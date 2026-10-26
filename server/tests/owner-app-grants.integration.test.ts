// server/tests/owner-app-grants.integration.test.ts
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
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  brokeredConnections,
  mcpServers,
  mcpTools,
  pluginGrants,
  teamBotConsents,
  teamBotPublications,
  users,
} from "../src/db/schema";
import type { AppAccess } from "../src/plugins/app-access";
import type { GiveableApp } from "../src/plugins/plugin-store/app-access";
import { createPluginRoutes } from "../src/plugins/routes";
import { createSharedUseStore } from "../src/plugins/shared-use-store";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import {
  createTeamBots,
  TEAM_BOT_CONSENT_MARKER,
} from "../src/team-bots/team-bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { stubBroker } from "./support/stub-broker";

/**
 * A Bot's owner giving one of their own apps to their own Bot — and the one rule that makes that
 * safe to publish: a grant the owner made runs on the ASKING person's own account, never the
 * owner's, even on the owner's published Team Bot.
 *
 * Real tables, real routes, the real Team Bot credential rule. The broker is the one thing faked,
 * and nothing here reaches it past the directory.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `${name}-${suite}`;

const owner = id("owner");
const teammate = id("teammate");
const admin = id("admin");
const people = [owner, teammate, admin];

const slug = (name: string) => `${name}_${suite}`;
const GMAIL = `composio-${slug("gmail")}`;
const SLACK = `composio-${slug("slack")}`;

const events: AuditEventInput[] = [];
const audit: AuditStore = {
  insert: async (event) => {
    events.push(event);
  },
};

const stub = stubBroker({
  grantIsLocal: true,
  authorizations: null,
  listApps: async () => [],
});
afterEach(() => {
  stub.expectNothingUnprovidedReached();
});

const store = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore: audit,
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker: stub.broker,
  deploymentId: `acme-${suite}`,
});

const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);

/** Which servers each person holds their own account on, as `index.ts` reads it for Team Bots. */
async function connectedServers(userId: string): Promise<Set<string>> {
  const rows = await database
    .select({ app: brokeredConnections.app })
    .from(brokeredConnections)
    .where(
      and(
        eq(brokeredConnections.holder, "person"),
        eq(brokeredConnections.userId, userId),
      ),
    );
  return new Set(rows.map((row) => `composio-${row.app}`));
}
const teamBots = createTeamBots({ database, connectedServers });

function appAs(actorId: string, role: "admin" | "user" = "user") {
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
  return new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      store,
      signedIn,
      async () => true,
      undefined,
      { broker: stub.broker, provider: "composio" },
      { modes: {} as never, use: createSharedUseStore(database, "composio") },
    ),
  );
}

const send = (method: string, body?: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function seedApp(
  key: string,
  title: string,
  accountMode: "personal" | "shared" = "personal",
) {
  await database.insert(mcpServers).values({
    id: key,
    title,
    vendor: "Composio",
    url: `composio://${key.replace(/^composio-/, "")}`,
    provenance: "composio",
    authScheme: "OAUTH2",
    accountMode,
    sharedVendorUserId:
      accountMode === "shared" ? `openbot-deployment:${suite}` : null,
  });
  await database.insert(mcpTools).values([
    {
      serverId: key,
      name: "FETCH",
      description: "Read",
      inputSchema: {},
      effect: "read",
    },
    {
      serverId: key,
      name: "SEND",
      description: "Send",
      inputSchema: {},
      effect: "write",
    },
  ]);
}

async function connect(userId: string, name = "gmail") {
  await database.insert(brokeredConnections).values({
    provider: "composio",
    app: slug(name),
    holder: "person",
    userId,
    vendorUserId: `vendor-${userId}`,
    verified: true,
  });
}

const createdBots: string[] = [];
async function botOf(actorId: string) {
  const profile = await profiles.create(
    { id: actorId, role: "user" } satisfies AgentActor,
    {
      name: "Research Helper",
      title: "Research",
      roleDescription: "Finds things out.",
      visibility: "private",
    },
  );
  createdBots.push(profile.id);
  return profile.id;
}

async function stateOf(actorId: string, botId: string, app = GMAIL) {
  const response = await appAs(actorId).request(
    `/api/plugins/for/${botId}/apps/${app}`,
  );
  return ((await response.json()) as { app: AppAccess }).app;
}

async function grantsOn(botId: string) {
  return database
    .select({ ref: pluginGrants.ref, grantedAs: pluginGrants.grantedAs })
    .from(pluginGrants)
    .where(eq(pluginGrants.agentId, botId));
}

async function clear() {
  await database
    .delete(teamBotConsents)
    .where(inArray(teamBotConsents.userId, people));
  if (createdBots.length) {
    await database
      .delete(teamBotPublications)
      .where(inArray(teamBotPublications.agentId, createdBots));
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, createdBots.splice(0)));
  }
  await database
    .delete(brokeredConnections)
    .where(like(brokeredConnections.app, `%${suite}%`));
  await database.delete(mcpServers).where(like(mcpServers.id, `%${suite}%`));
  await database.delete(agents).where(like(agents.name, "Research Helper"));
}

beforeAll(async () => {
  for (const user of people)
    await database.insert(users).values({
      id: user,
      email: `${user}@example.test`,
      name: user,
      emailVerified: true,
    });
});

beforeEach(async () => {
  events.length = 0;
  await clear();
  await seedApp(GMAIL, "Gmail");
});

afterAll(async () => {
  await clear();
  await database.delete(users).where(inArray(users.id, people));
});

describe("an owner giving their own app to their own Bot", () => {
  test("the card's state is theirs to give, and asks them to connect first when they haven't", async () => {
    const bot = await botOf(owner);
    expect(await stateOf(owner, bot)).toMatchObject({
      state: "owner_grantable",
      requestKind: null,
      ownerGrants: "any",
      needsConnect: true,
    });
    await connect(owner);
    expect(await stateOf(owner, bot)).toMatchObject({
      state: "owner_grantable",
      needsConnect: false,
    });
  });

  test("one press gives the read-only actions, marked as the owner's, and leaves a trail", async () => {
    const bot = await botOf(owner);
    await connect(owner);
    const given = await appAs(owner).request(
      `/api/plugins/for/${bot}/apps/${GMAIL}/give`,
      send("POST"),
    );
    expect(given.status).toBe(200);
    expect(await given.json()).toEqual({ granted: [`${GMAIL}/FETCH`] });
    expect(await grantsOn(bot)).toEqual([
      { ref: `${GMAIL}/FETCH`, grantedAs: "owner" },
    ]);
    expect(await stateOf(owner, bot)).toMatchObject({
      state: "ready",
      givenByOwner: true,
    });
    expect(
      events.find((event) => event.eventType === "app_access.owner_granted"),
    ).toMatchObject({ actorUserId: owner, payload: { bot, app: GMAIL } });
  });

  test("somebody else's Bot, an app kept for admins, and an app nobody turned on are refused", async () => {
    const bot = await botOf(owner);
    const others = await appAs(teammate).request(
      `/api/plugins/for/${bot}/apps/${GMAIL}/give`,
      send("POST"),
    );
    expect(others.status).toBe(403);
    expect(await stateOf(teammate, bot)).toMatchObject({
      state: "not_granted",
      requestKind: "grant",
    });

    await seedApp(SLACK, "Slack", "shared");
    const shared = await appAs(owner).request(
      `/api/plugins/for/${bot}/apps/${SLACK}/give`,
      send("POST"),
    );
    expect(shared.status).toBe(403);
    expect(((await shared.json()) as { error: string }).error).toBe(
      "Only an admin can give Slack to a Bot.",
    );

    // The admin opens Slack up; now it is the owner's to give.
    const opened = await appAs(admin, "admin").request(
      `/api/plugins/servers/${SLACK}/owner-grants`,
      send("PUT", { ownerGrants: "any" }),
    );
    expect(opened.status).toBe(200);
    expect((await stateOf(owner, bot, SLACK)).state).toBe("owner_grantable");
    expect(
      events.find(
        (event) =>
          (event.payload as { change?: string }).change ===
          "owner_grants_changed",
      ),
    ).toMatchObject({ targetId: SLACK, payload: { from: null, to: "any" } });

    // And an owner can never decide the rule themselves.
    const notAdmin = await appAs(owner).request(
      `/api/plugins/servers/${GMAIL}/owner-grants`,
      send("PUT", { ownerGrants: "admin" }),
    );
    expect(notAdmin.status).toBe(403);

    // An app this deployment never added stays an admin's to turn on.
    await database.delete(mcpServers).where(eq(mcpServers.id, GMAIL));
    const absent = await appAs(owner).request(
      `/api/plugins/grants`,
      send("POST", { kind: "mcp", ref: `${GMAIL}/FETCH`, agentId: bot }),
    );
    expect(absent.status).toBe(403);
    expect(await grantsOn(bot)).toEqual([]);
  });

  test("the grant route lets an owner add one action, and only the owner's grants can be taken back by them", async () => {
    const bot = await botOf(owner);
    const added = await appAs(owner).request(
      "/api/plugins/grants",
      send("POST", { kind: "mcp", ref: `${GMAIL}/SEND`, agentId: bot }),
    );
    expect(added.status).toBe(200);
    // An admin's grant beside it, which the owner did not give and cannot take.
    await store.grant("mcp", `${GMAIL}/FETCH`, bot, "admin@example.test");
    expect(await stateOf(owner, bot)).toMatchObject({ givenByOwner: false });

    const viaGrants = await appAs(owner).request(
      `/api/plugins/grants?kind=mcp&ref=${GMAIL}/SEND&agentId=${bot}`,
      send("DELETE"),
    );
    expect(viaGrants.status).toBe(403);

    const taken = await appAs(owner).request(
      `/api/plugins/for/${bot}/apps/${GMAIL}/give`,
      send("DELETE"),
    );
    expect(await taken.json()).toEqual({ revoked: [`${GMAIL}/SEND`] });
    expect(await grantsOn(bot)).toEqual([
      { ref: `${GMAIL}/FETCH`, grantedAs: "admin" },
    ]);
  });

  test("the grant route refuses an owner a ref the app does not advertise, and records nothing over an admin's grant", async () => {
    const bot = await botOf(owner);
    for (const ref of [`${GMAIL}/LATER`, GMAIL]) {
      const refused = await appAs(owner).request(
        "/api/plugins/grants",
        send("POST", { kind: "mcp", ref, agentId: bot }),
      );
      expect(refused.status).toBe(403);
    }
    expect(await grantsOn(bot)).toEqual([]);

    await store.grant("mcp", `${GMAIL}/FETCH`, bot, "admin@example.test");
    events.length = 0;
    const again = await appAs(owner).request(
      "/api/plugins/grants",
      send("POST", { kind: "mcp", ref: `${GMAIL}/FETCH`, agentId: bot }),
    );
    expect(again.status).toBe(200);
    expect(await grantsOn(bot)).toEqual([
      { ref: `${GMAIL}/FETCH`, grantedAs: "admin" },
    ]);
    expect(events).toEqual([]);
  });

  test("the apps a person could give are the ones they connected, and open to owners", async () => {
    await seedApp(SLACK, "Slack", "shared");
    const listed = async () =>
      (
        (await (
          await appAs(owner).request("/api/plugins/giveable")
        ).json()) as { apps: GiveableApp[] }
      ).apps.filter((app) => app.key.includes(suite));
    expect(await listed()).toEqual([]);
    await connect(owner);
    expect(await listed()).toEqual([
      { key: GMAIL, displayName: "Gmail", logo: null, account: "personal" },
    ]);
  });
});

describe("a Team Bot whose owner gave it their own Gmail", () => {
  test("a teammate's call uses the teammate's own account or asks them to connect, never the owner's", async () => {
    const bot = await botOf(owner);
    await connect(owner);
    const given = await appAs(owner).request(
      `/api/plugins/for/${bot}/apps/${GMAIL}/give`,
      send("POST"),
    );
    expect(given.status).toBe(200);
    await teamBots.publish({ id: owner, role: "user" }, bot, {
      audience: "team",
      emails: [],
      groups: [],
    });
    const ref = `${GMAIL}/FETCH`;
    const teammateCall = teamBots.credentialActorFor(teammate, bot);

    // Not connected: the teammate's own (absent) account, which the call then asks them to connect.
    expect(await teammateCall(ref)).toBe(teammate);
    expect(await stateOf(teammate, bot)).toMatchObject({
      state: "not_connected",
      accountHolder: "you",
    });

    // Connected: still the teammate's own, behind their consent, never the owner's.
    await connect(teammate);
    const asked = await teammateCall(ref).catch((error: unknown) => error);
    expect(asked).toBeInstanceOf(PluginRefusedError);
    expect((asked as Error).message).toStartWith(TEAM_BOT_CONSENT_MARKER);
    await teamBots.consent(
      { id: teammate, role: "user" },
      bot,
      GMAIL,
      "allow_always",
    );
    expect(await teammateCall(ref)).toBe(teammate);
    expect(await stateOf(teammate, bot)).toMatchObject({
      state: "ready",
      accountHolder: "you",
    });

    // The owner's own calls are theirs, as on any Bot of their own.
    expect(await teamBots.credentialActorFor(owner, bot)(ref)).toBe(owner);
  });

  test("the same Bot given Gmail by an admin uses the owner's account, as before", async () => {
    const bot = await botOf(owner);
    await connect(owner);
    await connect(teammate);
    await store.grant("mcp", `${GMAIL}/FETCH`, bot, "admin@example.test");
    await teamBots.publish({ id: owner, role: "user" }, bot, {
      audience: "team",
      emails: [],
      groups: [],
    });
    expect(
      await teamBots.credentialActorFor(teammate, bot)(`${GMAIL}/FETCH`),
    ).toBe(owner);
    expect(await stateOf(teammate, bot)).toMatchObject({
      state: "ready",
      accountHolder: "owner",
    });
  });
});
