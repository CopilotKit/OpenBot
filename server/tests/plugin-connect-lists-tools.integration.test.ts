import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MCPMock } from "@copilotkit/aimock/mcp";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { ActionPolicy } from "../src/computer/policy";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  credentials,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pluginGrants,
  users,
} from "../src/db/schema";
import { setEdition } from "../src/edition";
import { catalogueEntry } from "../src/plugins/catalogue";
import { redirectUriFor } from "../src/plugins/oauth";
import {
  personalDefaultsDeps,
  withPersonalDefaults,
} from "../src/plugins/personal-defaults";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Connecting an account to an app whose tools can only be listed as a person is enough for its
 * tools to be listed and offered to a Bot.
 *
 * THE BUG. Notion answers `tools/list` only with a person's token. Adding it lists nothing — there is
 * nobody to ask as, so the add records "answers as the person asking, and this run is not attributed
 * to anybody" — and the OAuth callback then recorded the person's connection and stopped. The app
 * read "Connected" while every Bot was told it held no Notion tools, until somebody pressed Refresh
 * tools on the app's page.
 *
 * Real store, real vault, real routes, real MCP over HTTP. The only stand-in is the vendor: Notion's
 * pinned host is answered here, its registration and token endpoints by hand and its MCP endpoint by
 * an MCP server that refuses any listing not carrying the person's access token.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);

const SERVER = "notion";
const personId = `user_connect_tools_${suite}`;
const botId = `agent_connect_tools_${suite}`;
/** Suite-scoped, so cleanup can find exactly these and none Notion really advertises. */
const toolNames = [`notion-fetch-${suite}`, `notion-search-${suite}`];
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PUBLIC_URL = "https://openbot.test";
const APP_URL = "https://app.openbot.test";
const CLIENT_ID = `dyn-${suite}`;
const REFRESH_TOKEN = `rt-${suite}`;
/** The only token the MCP endpoint lists tools for. */
const ACCESS_TOKEN = `at-${suite}`;
const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

const entry = catalogueEntry(SERVER);
if (entry?.auth.kind !== "user-oauth") {
  throw new Error("notion is not a user-oauth catalogue entry");
}
if (!entry.host) {
  throw new Error("notion has no host to list tools from");
}
const VENDOR = entry.host;

const realVault = createCredentialStore(database);
const createdCredentials = new Set<string>();
const vault = {
  ...realVault,
  create: async (
    value: Parameters<typeof realVault.create>[0],
    executor?: Parameters<typeof realVault.create>[1],
  ) => {
    const row = await realVault.create(value, executor);
    createdCredentials.add(row.id);
    return row;
  },
  rotate: async (
    value: Parameters<typeof realVault.rotate>[0],
    executor?: Parameters<typeof realVault.rotate>[1],
  ) => {
    const row = await realVault.rotate(value, executor);
    createdCredentials.add(row.id);
    return row;
  },
};

// Wired the way `index.ts` wires it: the personal edition's defaults wrap the store the routes use.
const store = withPersonalDefaults(
  createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: vault,
    encryptionKey: KEY,
    policy: () => policy,
    redirectUri: redirectUriFor(PUBLIC_URL),
  }),
  personalDefaultsDeps(database),
);

function signedIn(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: personId,
      email: `${personId}@openbot.test`,
      role: "admin",
    } as never);
    await next();
  };
}

const hono = new Hono().route(
  "/api/plugins",
  createPluginRoutes(store, signedIn(), async () => true, {
    publicUrl: PUBLIC_URL,
    appUrl: APP_URL,
    encryptionKey: KEY,
    personHasAccess: async (userId) => userId === personId,
  }),
);

const mock = new MCPMock();
for (const name of toolNames) {
  mock.addTool({
    name,
    description: `${name} for the test`,
    inputSchema: { type: "object", properties: {} },
  });
}
let mockUrl = "";
/** Every listing Notion's MCP endpoint was asked for, with the token it came with. */
const listedWith: (string | null)[] = [];
const realFetch = globalThis.fetch;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Notion, as far as this deployment can tell. */
async function vendor(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname === "/register") {
    return json({ client_id: CLIENT_ID });
  }
  if (url.pathname === "/token") {
    const params = new URLSearchParams(String(init?.body));
    if (params.get("client_id") !== CLIENT_ID) {
      return json({ error: "invalid_client" }, 401);
    }
    if (params.get("grant_type") === "authorization_code") {
      return json({ refresh_token: REFRESH_TOKEN, scope: "" });
    }
    if (
      params.get("grant_type") === "refresh_token" &&
      params.get("refresh_token") === REFRESH_TOKEN
    ) {
      return json({ access_token: ACCESS_TOKEN, expires_in: 3600 });
    }
    return json({ error: "invalid_grant" }, 400);
  }
  // The MCP endpoint answers only the person's token, which is what makes Notion per-person.
  const authorization = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  ).get("authorization");
  const body = String(init?.body ?? "");
  if (body.includes('"tools/list"')) listedWith.push(authorization);
  if (authorization !== `Bearer ${ACCESS_TOKEN}`) {
    return json({ error: "invalid_token" }, 401);
  }
  return realFetch(mockUrl, init);
}

beforeAll(async () => {
  // `notion` is the catalogue's id, not one this suite invents, so a row already there is somebody
  // else's and this suite would replace its tools. Refused rather than risked.
  const [existing] = await database
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(eq(mcpServers.id, SERVER));
  if (existing) {
    throw new Error(
      "The test database already has a notion server row, so this suite will not run against it.",
    );
  }

  mockUrl = await mock.start();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    return target.startsWith(VENDOR)
      ? vendor(input, init)
      : realFetch(input, init);
  }) as typeof fetch;
  setEdition("personal");

  await database
    .insert(users)
    .values({
      id: personId,
      email: `${personId}@openbot.test`,
      name: personId,
      emailVerified: false,
    })
    .onConflictDoNothing();
  await database
    .insert(agents)
    .values({ id: botId, name: botId, type: "built_in", configuration: {} })
    .onConflictDoNothing();
  await database
    .insert(agentProfiles)
    .values({
      agentId: botId,
      title: "",
      roleDescription: "",
      avatarSeed: botId,
      visibility: "public",
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  setEdition("team");
  globalThis.fetch = realFetch;
  await mock.stop?.();
  await database.delete(pluginGrants).where(
    inArray(
      pluginGrants.ref,
      toolNames.map((name) => `${SERVER}/${name}`),
    ),
  );
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, botId));
  await database
    .delete(mcpUserCredentials)
    .where(eq(mcpUserCredentials.userId, personId));
  await database.delete(mcpTools).where(eq(mcpTools.serverId, SERVER));
  await database.delete(mcpServers).where(eq(mcpServers.id, SERVER));
  if (createdCredentials.size > 0) {
    await database
      .delete(credentials)
      .where(inArray(credentials.id, [...createdCredentials]));
  }
  await database.delete(agentProfiles).where(eq(agentProfiles.agentId, botId));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.delete(users).where(eq(users.id, personId));
  await database.$client.end({ timeout: 5 });
});

describe("connecting an app that lists its tools only as a person", () => {
  test("lists its tools and offers them to a Bot, with nobody pressing Refresh", async () => {
    // Added the way the Connections page adds it. Nobody has connected, so nothing is listed.
    await store.addServer({ key: SERVER, by: personId });
    const added = (await store.listServers()).find(
      (server) => server.id === SERVER,
    );
    expect(added?.tools).toEqual([]);
    expect(added?.lastError).toContain("not attributed to anybody");

    // Connect, consent at the vendor, and come back through the real callback.
    const started = await hono.request(
      `http://t/api/plugins/servers/${SERVER}/connect`,
      { method: "POST" },
    );
    expect(started.status).toBe(200);
    const { authorizationUrl } = (await started.json()) as {
      authorizationUrl: string;
    };
    const state = new URL(authorizationUrl).searchParams.get("state") ?? "";
    const back = await hono.request(
      `http://t/api/plugins/oauth/callback?code=code-${suite}&state=${encodeURIComponent(state)}`,
    );
    expect(back.headers.get("location")).toBe(
      `${APP_URL}/connections/${SERVER}`,
    );

    // The app's page: its tools, listed as the person who connected, and no error.
    const connected = (await store.listServers()).find(
      (server) => server.id === SERVER,
    );
    expect(connected?.tools.map((tool) => tool.name).sort()).toEqual(
      [...toolNames].sort(),
    );
    expect(connected?.lastError).toBeNull();
    expect(listedWith).toContain(`Bearer ${ACCESS_TOKEN}`);

    // And what a Bot's run is offered.
    const offered = await store.listForAgent(botId);
    expect(
      offered.tools
        .map((tool) => tool.ref)
        .filter((ref) => ref.startsWith(`${SERVER}/`))
        .sort(),
    ).toEqual(toolNames.map((name) => `${SERVER}/${name}`).sort());
  });
});
