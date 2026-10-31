// server/tests/arcade-single-user-identity.integration.test.ts
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Hono, type MiddlewareHandler } from "hono";
import postgres from "postgres";
import { createAuditStore } from "../src/audit";
import {
  createDevRequireUser,
  DEV_ACTOR,
  initializeDevActorUser,
} from "../src/auth/dev-actor";
import type { AppVariables } from "../src/auth/guards";
import { applyMigrations } from "../src/db/apply-migrations";
import { createDatabase, type Database } from "../src/db/client";
import {
  agents,
  brokeredConnections,
  brokeredIdentities,
  mcpServers,
  mcpTools,
  pendingAuthorizations,
} from "../src/db/schema";
import { useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import { createPluginRoutes } from "../src/plugins/routes";
import { ensureSingleUserIdentity } from "../src/plugins/single-user-identity";
import { createPluginStore } from "../src/plugins/store";
import fixture from "./fixtures/arcade-catalogue.json";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { seedPeople } from "./support/people";

/**
 * EVERY SINGLE-USER OPENBOT ON ONE ARCADE KEY WAS ONE ARCADE USER, AND ITS GRANTS WERE NOWHERE HERE.
 *
 * WHAT WAS WRONG. A single-user deployment's one person is `dev-local-user`, and that id was the
 * `user_id` every Arcade call, consent and connection listing went out under. Composio's half of
 * this was closed by giving each single-user deployment its own name; Arcade was left out because
 * its broker declared its grants held at Arcade, with no row here, so nothing local could say
 * whether a deployment already held grants under the shared name. One deployment's consent to Google
 * was therefore the grant every other deployment on the key ran its Bots on, and a page load in one
 * recorded the other's connection as its own.
 *
 * WHAT IS ASSERTED. Arcade's grants are now recorded here as Composio's are, and the same identity
 * rule runs for both. Two single-user deployments, each with its own database, on one Arcade key:
 * each sends Arcade its own `user_id`, a consent made in one is not listed, confirmed or used in the
 * other, a Bot call needs this deployment's own row, and a disconnect in one leaves the other's
 * grant alone. Connect asks Arcade for the whole app, as Composio's Connect does, and comes back
 * through the verifier, which writes the row. A deployment that already holds Arcade grants under
 * `dev-local-user` keeps that name, the name survives a restart, and a deployment that signs people
 * in files them under their own ids as before.
 *
 * REAL DATABASES, REAL ROUTES, THE REAL SINGLE-USER GUARD, THE REAL STORE, THE REAL ADAPTER AND THE
 * REAL SDK. Arcade is faked at its HTTP boundary only, through `ARCADE_BASE_URL`, as
 * `arcade-confirm-engine.test.ts` does: `@arcadeai/arcadejs` builds and parses every request
 * itself. The engine answers in the shapes the live API does, with the page envelope and tool
 * metadata read out of `fixtures/arcade-catalogue.json`, connections keyed on (user, provider
 * instance) and a tool authorized only where its scopes are held, as `arcade-journey` sets out.
 */

const server = new URL(testDatabaseUrl());
const administrative = new URL(server.href);
administrative.pathname = "/postgres";
const suite = randomUUID().slice(0, 8);
const migrations = join(import.meta.dir, "..", "drizzle");

const created: string[] = [];
const opened: Database[] = [];

const BOT = "helper";
const TOOLKIT = "Gmail";
const ROW = `arcade-${TOOLKIT}`;
const READ = `${TOOLKIT}.ListEmails`;
const SEND = `${TOOLKIT}.SendEmail`;
const APP_URL = "https://app.example";
/** The provider TYPE a tool listing names, and the INSTANCE a connection is held under. */
const PROVIDER_TYPE = "google";
const PROVIDER = "arcade-google";
const SCOPES: Record<string, string[]> = {
  [READ]: ["https://www.googleapis.com/auth/gmail.readonly"],
  [SEND]: ["https://www.googleapis.com/auth/gmail.send"],
};
/** A stand-in for the live access token Arcade's status answer carries. */
const LIVE_TOKEN = `ya29.live-${suite}`;

/** A database of its own, migrated as a deployment's would be, and dropped after the file. */
async function freshDatabase(): Promise<string> {
  const name = `openbot_arcade_identity_${suite}_${created.length}`;
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  created.push(name);
  const url = new URL(server.href);
  url.pathname = `/${name}`;
  const client = postgres(url.href, { max: 1, onnotice: () => {} });
  try {
    await applyMigrations(client, migrations);
  } finally {
    await client.end({ timeout: 5 });
  }
  return url.href;
}

function open(url: string): Database {
  const database = createDatabase(url, TEST_POOL);
  opened.push(database);
  return database;
}

async function close(database: Database) {
  opened.splice(opened.indexOf(database), 1);
  await database.$client.close();
}

/* ------------------------------------------------------------------ Arcade, at its own wire */

const recorded = fixture.tools as unknown as Record<
  string,
  { metadata: unknown }
>;
const envelope = fixture.page_envelope as Record<string, unknown>;

/** One Gmail action as the live listing publishes it: the recorded shape, Gmail's names. */
function published(qualified: string, metadata: unknown) {
  const name = qualified.slice(TOOLKIT.length + 1);
  return {
    fully_qualified_name: `${qualified}@3.1.0`,
    qualified_name: qualified,
    name,
    description: `${name} in the person's mailbox.`,
    toolkit: {
      name: TOOLKIT,
      description: "Arcade tools designed for LLMs to interact with Gmail",
      version: "3.1.0",
    },
    input: { parameters: [] },
    requirements: {
      met: true,
      authorization: {
        id: PROVIDER,
        provider_id: PROVIDER_TYPE,
        provider_type: "oauth2",
        oauth2: { scopes: SCOPES[qualified] },
        status: "active",
      },
    },
    metadata,
  };
}

const CATALOGUE = [
  published(READ, recorded.read?.metadata),
  published(SEND, recorded.write?.metadata),
];

type Connection = {
  id: string;
  connection_id: string;
  connection_status: "active";
  provider_id: string;
  provider_type: "oauth2";
  provider_description: string;
  provider_user_info: { email: string; name: string };
  scopes: string[];
  user_id: string;
};

type Flow = {
  userId: string;
  scopes: string[];
  status: "pending" | "completed";
  handle: string;
  mailbox: string | null;
};

/** A page, in the envelope the live API wraps every listing in. */
const page = (items: unknown[], url: URL) => {
  const limit = Number(url.searchParams.get("limit") ?? items.length) || 100;
  const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
  const slice = items.slice(offset, offset + limit);
  return {
    ...envelope,
    limit,
    offset,
    page_count: slice.length,
    total_count: items.length,
    items: slice,
  };
};

/**
 * One Arcade project, as the one API key every deployment here shares sees it: the connections it
 * holds, every authorization it minted, every tool it ran and every request it was sent.
 */
function arcadeProject() {
  const connections: Connection[] = [];
  const flows = new Map<string, Flow>();
  const byHandle = new Map<string, string>();
  /** Every mint, with the `user_id` it named and, for a whole-app mint, the requirement. */
  const minted: { path: string; userId: string; body: unknown }[] = [];
  /** Every tool Arcade ran, as whom and in which mailbox. */
  const ran: { userId: string; tool: string; mailbox: string }[] = [];
  const deleted: string[] = [];
  /** Anything asked of this engine that it does not serve. */
  const unexpected: string[] = [];
  let next = 0;

  const held = (userId: string) =>
    connections.find(
      (row) => row.user_id === userId && row.provider_id === PROVIDER,
    );
  const holds = (userId: string, scopes: string[]) => {
    const row = held(userId);
    return row !== undefined && scopes.every((s) => row.scopes.includes(s));
  };

  /** A person finishing Google's consent for `userId`: Arcade now holds these scopes for them. */
  function grant(userId: string, scopes: string[], mailbox: string) {
    const row = held(userId);
    if (row) {
      row.scopes = [...new Set([...row.scopes, ...scopes])].sort();
      return;
    }
    next += 1;
    connections.push({
      id: `at_${next}`,
      connection_id: `ac_${next}`,
      connection_status: "active",
      provider_id: PROVIDER,
      provider_type: "oauth2",
      provider_description: "Arcade's default Google provider",
      provider_user_info: { email: mailbox, name: mailbox },
      scopes: [...scopes].sort(),
      user_id: userId,
    });
  }

  function mint(path: string, userId: string, scopes: string[], body: unknown) {
    minted.push({ path, userId, body });
    next += 1;
    const id = `ar_${next}`;
    if (holds(userId, scopes)) {
      return {
        id,
        status: "completed",
        provider_id: PROVIDER_TYPE,
        scopes,
        user_id: userId,
      };
    }
    const handle = `fl_${next}`;
    flows.set(id, { userId, scopes, status: "pending", handle, mailbox: null });
    byHandle.set(handle, id);
    return {
      id,
      status: "pending",
      // A BEARER CAPABILITY, as the live one is. The flow is named in it only so the test can play
      // the person's browser; the verifier is sent the handle, never the `ar_…` id.
      url: `https://cloud.arcade.test/oauth/consent?flow=${handle}&secret=bearer`,
      provider_id: PROVIDER_TYPE,
      scopes,
      user_id: userId,
    };
  }

  const refuse = (status: number, name: string, message: string) =>
    Response.json({ name, message }, { status });

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    const body =
      request.method === "POST"
        ? ((await request.json()) as Record<string, unknown>)
        : {};

    if (route === "GET /v1/tools") {
      const userId = url.searchParams.get("user_id");
      const items = CATALOGUE.filter(
        (item) => item.toolkit.name === url.searchParams.get("toolkit"),
      ).map((item) =>
        // Asked about somebody, the listing answers about them, on `token_status`.
        userId
          ? {
              ...item,
              requirements: {
                ...item.requirements,
                authorization: {
                  ...item.requirements.authorization,
                  token_status: holds(userId, SCOPES[item.qualified_name] ?? [])
                    ? "completed"
                    : "not_started",
                },
              },
            }
          : item,
      );
      return Response.json(page(items, url));
    }
    if (route === "POST /v1/tools/authorize") {
      const tool = String(body.tool_name);
      return Response.json(
        mint(url.pathname, String(body.user_id), SCOPES[tool] ?? [], body),
      );
    }
    if (route === "POST /v1/auth/authorize") {
      const requirement = body.auth_requirement as {
        oauth2?: { scopes?: string[] };
      };
      return Response.json(
        mint(
          url.pathname,
          String(body.user_id),
          requirement?.oauth2?.scopes ?? [],
          body,
        ),
      );
    }
    if (route === "POST /v1/auth/confirm_user") {
      const id = byHandle.get(String(body.flow_id));
      const flow = id ? flows.get(id) : undefined;
      if (!id || !flow) return refuse(404, "not_found", "No such flow.");
      if (flow.userId !== body.user_id) {
        return refuse(
          400,
          "user_mismatch",
          "An error occurred during verification.",
        );
      }
      // The consent finished at Google before the browser came back, which is the true order.
      flow.status = "completed";
      grant(flow.userId, flow.scopes, flow.mailbox ?? "nobody@example.test");
      return Response.json({
        auth_id: id,
        next_uri: "https://cloud.arcade.test/done",
      });
    }
    if (route === "GET /v1/auth/status") {
      const id = url.searchParams.get("id") ?? "";
      const flow = flows.get(id);
      if (!flow) return refuse(404, "not_found", "No such authorization.");
      return Response.json({
        id,
        status: flow.status,
        user_id: flow.userId,
        scopes: flow.scopes,
        provider_id: PROVIDER_TYPE,
        context: {
          token: LIVE_TOKEN,
          user_info: { email: flow.mailbox },
        },
      });
    }
    if (route === "POST /v1/tools/execute") {
      const userId = String(body.user_id);
      const tool = String(body.tool_name);
      if (!holds(userId, SCOPES[tool] ?? [])) {
        return refuse(
          403,
          "tool_authorization_required",
          `${tool} needs authorization.`,
        );
      }
      const mailbox = held(userId)?.provider_user_info.email ?? "";
      ran.push({ userId, tool, mailbox });
      return Response.json({
        id: `te_${ran.length}`,
        execution_id: `tc_${ran.length}`,
        execution_type: "immediate",
        status: "success",
        success: true,
        output: { value: { mailbox, messages: [] } },
      });
    }
    if (route === "GET /v1/admin/auth_providers") {
      return Response.json(
        page(
          [
            {
              id: PROVIDER,
              provider_id: PROVIDER_TYPE,
              type: "oauth2",
              status: "active",
              description: "Arcade's default Google provider",
            },
          ],
          url,
        ),
      );
    }
    if (route === "GET /v1/admin/user_connections") {
      const userId = url.searchParams.get("user_id");
      const providerId = url.searchParams.get("provider_id");
      return Response.json(
        page(
          connections.filter(
            (row) =>
              (!userId || row.user_id === userId) &&
              (!providerId || row.provider_id === providerId),
          ),
          url,
        ),
      );
    }
    if (
      request.method === "DELETE" &&
      url.pathname.startsWith("/v1/admin/user_connections/")
    ) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const at = connections.findIndex((row) => row.connection_id === id);
      if (at < 0) return refuse(404, "not_found", "No such connection.");
      connections.splice(at, 1);
      deleted.push(id);
      return new Response(null, { status: 204 });
    }
    unexpected.push(route);
    return refuse(404, "not_found", `${route} is not served here.`);
  }

  return {
    handle,
    connections,
    minted,
    ran,
    deleted,
    unexpected,
    grant,
    /**
     * The person opening the consent link and finishing Google's screen as `mailbox`. Answers the
     * handle Arcade then sends their browser to the verifier with.
     */
    consent(authorizationUrl: string, mailbox: string): string {
      const handle = new URL(authorizationUrl).searchParams.get("flow") ?? "";
      const id = byHandle.get(handle);
      const flow = id ? flows.get(id) : undefined;
      if (!flow) throw new Error(`${authorizationUrl} names no flow.`);
      flow.mailbox = mailbox;
      return handle;
    },
  };
}

let project = arcadeProject();
let engine: ReturnType<typeof Bun.serve> | null = null;
const wasBaseURL = process.env.ARCADE_BASE_URL;
/** The one Arcade client every deployment here holds: one key, as the defect needs. */
let client: ReturnType<typeof createArcadeClient>;

beforeAll(() => {
  // A port of the few this run may use, the first one free.
  for (const port of [7485, 7486, 7487, 7488, 7489]) {
    try {
      engine = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: (request) => project.handle(request),
      });
      break;
    } catch {
      engine = null;
    }
  }
  if (!engine) throw new Error("No port from 7485 to 7489 was free.");
  // Read by `new Arcade({ apiKey })`, so it is set before the client is built.
  process.env.ARCADE_BASE_URL = `http://127.0.0.1:${engine.port}`;
  client = createArcadeClient(`arcade-test-key-${suite}`);
  useArcadeClient(client.actions);
});

beforeEach(() => {
  project = arcadeProject();
});

afterAll(async () => {
  useArcadeClient(null);
  engine?.stop(true);
  if (wasBaseURL === undefined) delete process.env.ARCADE_BASE_URL;
  else process.env.ARCADE_BASE_URL = wasBaseURL;
  for (const database of opened) await database.$client.close();
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    for (const name of created) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
});

/* ------------------------------------------------------------------ a deployment, booted */

/** Arcade as `index.ts` hands it over: the provider, and what its adapter declares. */
const arcadeWired = () => ({
  provider: "arcade" as const,
  grantIsLocal: client.broker.grantIsLocal,
});

/** A guard that signs one named person in, as a deployment that signs people in does. */
const signedInAs =
  (id: string): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (context, next) => {
    context.set("actor", { id, email: `${id}@example.test`, role: "user" });
    await next();
  };

/**
 * A deployment starting: its person written, its Arcade name settled, and its store and routes
 * built over its own database. Single-user unless a signed-in person is named.
 *
 * `settled` IS WHAT `ensureSingleUserIdentity` ANSWERED, and `identity` the name calls go out
 * under, which is the person's own id where nothing was settled.
 */
async function boot(url: string, signedIn?: string) {
  const database = open(url);
  await initializeDevActorUser(database, signedIn === undefined);
  if (signedIn) await seedPeople(database, [signedIn]);
  const actor = signedIn ?? DEV_ACTOR.id;
  const settled = await ensureSingleUserIdentity(database, {
    singleUser: signedIn === undefined,
    broker: arcadeWired(),
  });
  const identity = settled ?? actor;
  const store = createPluginStore({
    brokerProvider: "arcade",
    database,
    auditStore: createAuditStore(database),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker: client.broker,
    deploymentId: "single-user",
  });
  const app = new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      store,
      signedIn ? signedInAs(signedIn) : createDevRequireUser(),
      async () => true,
      {
        publicUrl: "https://openbot.example",
        appUrl: APP_URL,
        encryptionKey: `${"A".repeat(43)}=`,
        personHasAccess: async () => true,
      },
      { broker: client.broker, provider: "arcade" },
    ),
  );
  /** What a Bot granted Gmail does for the person. */
  const call = (tool: string) =>
    store.callTool({
      ref: `${ROW}/${tool.slice(TOOLKIT.length + 1)}`,
      args: {},
      botId: BOT,
      actorId: actor,
    });
  return { database, actor, settled, identity, store, app, call };
}

type Deployment = Awaited<ReturnType<typeof boot>>;

/** Gmail turned on as a Personal app with two actions, and a Bot given both. */
async function enableGmail({ database, store }: Deployment) {
  await database.insert(mcpServers).values({
    id: ROW,
    title: "Gmail",
    vendor: "Arcade",
    url: `arcade://${TOOLKIT}`,
    provenance: "arcade",
    authScheme: "OAUTH2",
    accountMode: "personal",
  });
  await database.insert(mcpTools).values([
    {
      serverId: ROW,
      name: "ListEmails",
      vendorName: READ,
      description: "List emails.",
      effect: "read",
    },
    {
      serverId: ROW,
      name: "SendEmail",
      vendorName: SEND,
      description: "Send an email.",
      effect: "write",
      destructive: false,
    },
  ]);
  await database
    .insert(agents)
    .values({ id: BOT, name: "Helper", type: "built_in", configuration: {} });
  for (const name of ["ListEmails", "SendEmail"]) {
    await store.grant("mcp", `${ROW}/${name}`, BOT, DEV_ACTOR.email);
  }
}

async function newDeployment(signedIn?: string) {
  const deployment = await boot(await freshDatabase(), signedIn);
  await enableGmail(deployment);
  return deployment;
}

const confirm = async (deployment: Deployment) =>
  (await (
    await deployment.app.request(
      `/api/plugins/servers/${ROW}/connection/confirm`,
      { method: "POST" },
    )
  ).json()) as { connected?: boolean; error?: string };

const listed = async (deployment: Deployment) =>
  (
    (await (
      await deployment.app.request("/api/plugins/connections")
    ).json()) as { connections: { serverId: string }[] }
  ).connections.map((connection) => connection.serverId);

const rowsIn = (database: Database) =>
  database
    .select({
      provider: brokeredConnections.provider,
      app: brokeredConnections.app,
      userId: brokeredConnections.userId,
      vendorUserId: brokeredConnections.vendorUserId,
    })
    .from(brokeredConnections);

/** The browser coming back from Arcade to the verifier, and where it is sent on to. */
async function returnFrom(
  deployment: Deployment,
  authorizationUrl: string,
  mailbox: string,
) {
  const flow = project.consent(authorizationUrl, mailbox);
  const back = await deployment.app.request(
    `/api/plugins/arcade/verify?flow_id=${flow}`,
  );
  expect(back.status).toBe(303);
  return back.headers.get("location");
}

/** Authorize pressed for one action, consent finished at Google as `mailbox`, and the return. */
async function authorizeAction(
  deployment: Deployment,
  action: string,
  mailbox: string,
) {
  const response = await deployment.app.request(
    `/api/plugins/servers/${ROW}/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    },
  );
  expect(response.status).toBe(200);
  const { authorizationUrl } = (await response.json()) as {
    authorizationUrl: string;
  };
  expect(project.minted.at(-1)).toMatchObject({
    path: "/v1/tools/authorize",
    userId: deployment.identity,
  });
  expect(await returnFrom(deployment, authorizationUrl, mailbox)).toBe(
    `${APP_URL}/connections/${ROW}?action=${encodeURIComponent(action)}`,
  );
}

/** Connect pressed, the whole app consented to at Google as `mailbox`, and the return. */
async function connectGmail(deployment: Deployment, mailbox: string) {
  const response = await deployment.app.request(
    `/api/plugins/servers/${ROW}/connect`,
    { method: "POST" },
  );
  expect(response.status).toBe(200);
  const { authorizationUrl } = (await response.json()) as {
    authorizationUrl: string;
  };
  // One consent for everything the app's actions need, under this deployment's own name.
  expect(project.minted.at(-1)).toEqual({
    path: "/v1/auth/authorize",
    userId: deployment.identity,
    body: {
      auth_requirement: {
        id: PROVIDER,
        provider_id: PROVIDER_TYPE,
        provider_type: "oauth2",
        oauth2: { scopes: [...SCOPES[READ], ...SCOPES[SEND]].sort() },
      },
      user_id: deployment.identity,
    },
  });
  expect(await returnFrom(deployment, authorizationUrl, mailbox)).toBe(
    `${APP_URL}/connections/${ROW}?action=${TOOLKIT}`,
  );
  expect(await rowsIn(deployment.database)).toEqual([
    {
      provider: "arcade",
      app: TOOLKIT,
      userId: deployment.actor,
      vendorUserId: deployment.identity,
    },
  ]);
}

describe("two single-user deployments on one Arcade key", () => {
  test("each is its own Arcade user, and a consent made in one is not listed, confirmed or used in the other", async () => {
    const a = await newDeployment();
    const b = await newDeployment();

    // Same person here, two names at Arcade.
    expect(a.settled).toStartWith(`${DEV_ACTOR.id}:`);
    expect(b.settled).toStartWith(`${DEV_ACTOR.id}:`);
    expect(a.identity).not.toBe(b.identity);

    // A approves reading mail, one action, and the verifier records it under A's name.
    await authorizeAction(a, READ, "a@example.test");
    expect(await rowsIn(a.database)).toEqual([
      {
        provider: "arcade",
        app: TOOLKIT,
        userId: DEV_ACTOR.id,
        vendorUserId: a.identity,
      },
    ]);
    expect(project.connections.map((row) => row.user_id)).toEqual([a.identity]);

    // B's page does not list A's Gmail, and asking Arcade from B finds nothing of A's.
    expect(await listed(b)).not.toContain(ROW);
    expect(await confirm(b)).toEqual({ connected: false });
    expect(await rowsIn(b.database)).toEqual([]);

    // A Bot on B cannot read A's mail: it is told to connect, and nothing runs at Arcade.
    await expect(b.call(READ)).rejects.toThrow(
      "You have not connected your Gmail account.",
    );
    expect(project.ran).toEqual([]);

    // A's Bot reads A's mail, as A.
    const read = await a.call(READ);
    expect(read.isError).toBe(false);
    expect(read.text).toContain("a@example.test");
    expect(project.ran).toEqual([
      { userId: a.identity, tool: READ, mailbox: "a@example.test" },
    ]);
    expect(project.unexpected).toEqual([]);
  });

  test("Connect asks each for the whole app under its own name, and a disconnect in one leaves the other's grant alone", async () => {
    const a = await newDeployment();
    const b = await newDeployment();

    await connectGmail(a, "a@example.test");
    await connectGmail(b, "b@example.test");

    // Each Bot sends from its own deployment's mailbox, whichever consented last.
    expect((await a.call(SEND)).text).toContain("a@example.test");
    expect((await b.call(SEND)).text).toContain("b@example.test");
    expect(project.ran).toEqual([
      { userId: a.identity, tool: SEND, mailbox: "a@example.test" },
      { userId: b.identity, tool: SEND, mailbox: "b@example.test" },
    ]);

    // B disconnects. Arcade ends B's connection and only B's, and B's row goes with it.
    const ended = await b.app.request(
      `/api/plugins/servers/${ROW}/connection`,
      {
        method: "DELETE",
      },
    );
    expect(ended.status).toBe(200);
    expect(await ended.json()).toEqual({ vendorRevocationRequested: true });
    expect(project.connections.map((row) => row.user_id)).toEqual([a.identity]);
    expect(await rowsIn(b.database)).toEqual([]);
    await expect(b.call(SEND)).rejects.toThrow(
      "You have not connected your Gmail account.",
    );

    // A is still connected, and its Bot still sends as A.
    expect(await confirm(a)).toEqual({ connected: true });
    expect((await a.call(READ)).text).toContain("a@example.test");
    expect(project.unexpected).toEqual([]);
  });
});

describe("a single-user deployment that already holds Arcade grants under dev-local-user", () => {
  /** Gmail approved the way every single-user OpenBot approved it before its own name existed. */
  async function approvedBeforeTheUpgrade() {
    const url = await freshDatabase();
    const before = open(url);
    await before.insert(brokeredConnections).values({
      provider: "arcade",
      app: TOOLKIT,
      holder: "person",
      userId: DEV_ACTOR.id,
      vendorUserId: DEV_ACTOR.id,
      verified: true,
      verifiedAt: new Date(),
    });
    await close(before);
    project.grant(DEV_ACTOR.id, SCOPES[READ] ?? [], "me@example.test");
    return url;
  }

  test("keeps that name, so its Gmail stays connected and nothing is approved again", async () => {
    const deployment = await boot(await approvedBeforeTheUpgrade());
    await enableGmail(deployment);

    expect(deployment.settled).toBe(DEV_ACTOR.id);
    expect(await deployment.database.select().from(brokeredIdentities)).toEqual(
      [],
    );
    expect(await listed(deployment)).toContain(ROW);
    expect(await confirm(deployment)).toEqual({ connected: true });
    expect((await deployment.call(READ)).text).toContain("me@example.test");
    expect(project.ran).toEqual([
      { userId: DEV_ACTOR.id, tool: READ, mailbox: "me@example.test" },
    ]);
    expect(project.minted).toEqual([]);
  });

  test("gets its own name at the first start after its last such grant is disconnected", async () => {
    const url = await approvedBeforeTheUpgrade();
    const before = await boot(url);
    await enableGmail(before);
    expect(before.settled).toBe(DEV_ACTOR.id);

    const ended = await before.app.request(
      `/api/plugins/servers/${ROW}/connection`,
      { method: "DELETE" },
    );
    expect(ended.status).toBe(200);
    expect(project.connections).toEqual([]);
    await close(before.database);

    const after = await boot(url);
    expect(after.settled).toStartWith(`${DEV_ACTOR.id}:`);
    await connectGmail(after, "me@example.test");
    expect((await after.call(READ)).text).toContain("me@example.test");
    expect(project.ran).toEqual([
      { userId: after.identity, tool: READ, mailbox: "me@example.test" },
    ]);
  });
});

describe("a single-user deployment's Arcade name", () => {
  test("is the same after a restart, and the grant made under it is still the one used", async () => {
    const url = await freshDatabase();
    const first = await boot(url);
    await enableGmail(first);
    expect(first.settled).toStartWith(`${DEV_ACTOR.id}:`);
    await connectGmail(first, "me@example.test");
    await close(first.database);

    const restarted = await boot(url);
    expect(restarted.settled).toBe(first.settled);
    expect(await confirm(restarted)).toEqual({ connected: true });
    expect((await restarted.call(READ)).text).toContain("me@example.test");
    expect(project.ran).toEqual([
      { userId: first.identity, tool: READ, mailbox: "me@example.test" },
    ]);
    // One consent, made before the restart. Nothing was approved again.
    expect(project.minted).toHaveLength(1);
  });
});

describe("Connect on an app Arcade already holds for this deployment's name", () => {
  test("records the connection it finds instead of asking anybody to consent again", async () => {
    /*
     * COMPOSIO'S HELD ACCOUNT, ON ARCADE. The row is gone here (a restore, a confirm that heard
     * no once) while Arcade still holds every scope the app asks for under this deployment's own
     * name. Arcade answers the whole-app mint `completed`, and Connect records what it holds, as
     * a confirm on page load would, rather than sending the person round a finished consent.
     */
    const deployment = await newDeployment();
    project.grant(
      deployment.identity,
      [...(SCOPES[READ] ?? []), ...(SCOPES[SEND] ?? [])],
      "me@example.test",
    );

    const response = await deployment.app.request(
      `/api/plugins/servers/${ROW}/connect`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: true });
    expect(await rowsIn(deployment.database)).toEqual([
      {
        provider: "arcade",
        app: TOOLKIT,
        userId: DEV_ACTOR.id,
        vendorUserId: deployment.identity,
      },
    ]);
    // Asked under this deployment's own name, and no attempt is left holding the person.
    expect(project.minted.map((mint) => mint.userId)).toEqual([
      deployment.identity,
    ]);
    expect(
      await deployment.database.select().from(pendingAuthorizations),
    ).toEqual([]);
    expect((await deployment.call(SEND)).text).toContain("me@example.test");
    expect(project.unexpected).toEqual([]);
  });
});

describe("a deployment that signs people in", () => {
  test("files each person under their own id at Arcade, and writes no name for anybody", async () => {
    const alice = `alice-${suite}`;
    const deployment = await newDeployment(alice);

    expect(deployment.settled).toBeNull();
    expect(await deployment.database.select().from(brokeredIdentities)).toEqual(
      [],
    );

    await connectGmail(deployment, "alice@example.test");
    expect(deployment.identity).toBe(alice);
    expect((await deployment.call(SEND)).text).toContain("alice@example.test");
    expect(project.ran).toEqual([
      { userId: alice, tool: SEND, mailbox: "alice@example.test" },
    ]);
    expect(project.unexpected).toEqual([]);
  });
});
