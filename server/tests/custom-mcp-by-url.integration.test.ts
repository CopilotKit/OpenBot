import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  type EnterpriseControls,
  installEnterpriseControls,
} from "../src/admin/controls";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { ActionPolicy } from "../src/computer/policy";
import { createCredentialStore, decryptSecret } from "../src/credentials";
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
import { redirectUriFor } from "../src/plugins/oauth";
import {
  personalDefaultsDeps,
  withPersonalDefaults,
} from "../src/plugins/personal-defaults";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  type OAuthMcpServer,
  startOAuthMcpServer,
} from "./support/oauth-mcp-server";

/**
 * Adding an MCP server by its address, from Connections, through the real routes, the real store,
 * the real vault and a real MCP server that signs people in with OAuth on 127.0.0.1.
 *
 * Nothing between OpenBot and the server is stubbed: discovery, registration, the consent redirect,
 * PKCE, the `resource` parameter, `iss`, the code exchange, the token kept in the vault, the tool
 * listing as the person, and a Bot's call all go over HTTP to `oauth-mcp-server.ts`.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PUBLIC_URL = "https://openbot.test";
const APP_URL = "https://app.openbot.test";
const personId = `user_by_url_${suite}`;
const botId = `agent_by_url_${suite}`;
const TITLE = `Notes ${suite}`;
const SERVER = `notes-${suite}`;
const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

const vault = createCredentialStore(database);
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

let role: "admin" | "user" = "admin";
function signedIn(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: personId,
      email: `${personId}@openbot.test`,
      role,
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

const addByUrl = (body: Record<string, unknown>) =>
  hono.request("http://t/api/plugins/servers/by-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const appState = async () =>
  (
    await store.inspectApp({
      app: SERVER,
      agentId: botId,
      userId: personId,
      composioConfigured: false,
      ownerGrantsAllowed: true,
    })
  )?.access.state;

let fixture: OAuthMcpServer;
const loopbackBefore = process.env.OPENBOT_ALLOW_LOOPBACK_MCP;

beforeAll(async () => {
  fixture = startOAuthMcpServer({ title: TITLE });
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
  if (loopbackBefore === undefined)
    delete process.env.OPENBOT_ALLOW_LOOPBACK_MCP;
  else process.env.OPENBOT_ALLOW_LOOPBACK_MCP = loopbackBefore;
  fixture.stop();
  const rows = await database
    .select({ id: mcpServers.id, credentialId: mcpServers.credentialId })
    .from(mcpServers)
    .where(like(mcpServers.id, `%${suite}%`));
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await database
      .delete(pluginGrants)
      .where(like(pluginGrants.ref, `%${suite}%`));
    const held = await database
      .select({ credentialId: mcpUserCredentials.credentialId })
      .from(mcpUserCredentials)
      .where(inArray(mcpUserCredentials.serverId, ids));
    await database
      .delete(mcpUserCredentials)
      .where(inArray(mcpUserCredentials.serverId, ids));
    await database.delete(mcpTools).where(inArray(mcpTools.serverId, ids));
    await database.delete(mcpServers).where(inArray(mcpServers.id, ids));
    const owned = [
      ...held.map((row) => row.credentialId),
      ...rows.map((row) => row.credentialId).filter((id): id is string => !!id),
    ];
    if (owned.length > 0)
      await database.delete(credentials).where(inArray(credentials.id, owned));
  }
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, botId));
  await database.delete(agentProfiles).where(eq(agentProfiles.agentId, botId));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.delete(users).where(eq(users.id, personId));
  await database.$client.end({ timeout: 5 });
});

describe("adding an MCP server by URL", () => {
  test("refuses an address on this machine unless loopback servers are turned on", async () => {
    delete process.env.OPENBOT_ALLOW_LOOPBACK_MCP;
    for (const url of [
      fixture.url,
      "http://127.0.0.1:1/mcp",
      "https://localhost/mcp",
      "https://169.254.169.254/latest",
      "https://metadata.google.internal/mcp",
      "https://db.svc/mcp",
      "http://mcp.example.com/mcp",
      "https://user:pass@mcp.example.com/mcp",
      "https://mcp.example.com/mcp?api_key=x",
    ]) {
      const refused = await addByUrl({ title: "Anything", url });
      expect({ url, status: refused.status }).toEqual({ url, status: 400 });
    }
    const rows = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(like(mcpServers.id, `%${suite}%`));
    expect(rows).toEqual([]);
  });

  test("signs a person in with OAuth, keeps their token, lists the tools and lets a Bot call one", async () => {
    process.env.OPENBOT_ALLOW_LOOPBACK_MCP = "1";
    setEdition("personal");

    // Added from Connections: the server answers 401 with an OAuth challenge.
    const added = await addByUrl({ title: TITLE, url: fixture.url });
    expect(added.status).toBe(200);
    const { server, signIn } = (await added.json()) as {
      server: { id: string; signIn: boolean; tools: unknown[] };
      signIn: boolean;
    };
    expect(signIn).toBe(true);
    expect(server.id).toBe(SERVER);
    expect(server.signIn).toBe(true);
    expect(server.tools).toEqual([]);
    const [row] = await database
      .select({ oauth: mcpServers.oauth, provenance: mcpServers.provenance })
      .from(mcpServers)
      .where(eq(mcpServers.id, SERVER));
    expect(row?.provenance).toBe("custom");
    expect(row?.oauth?.resource).toBe(fixture.url);
    expect(row?.oauth?.authorizationServer).toBe(fixture.origin);

    // The same address again is the same server, not a second one.
    const again = await addByUrl({ title: "Again", url: `${fixture.url}/` });
    expect(again.status).toBe(409);

    // Connect: OpenBot registers itself and sends the person to the server's consent page.
    const started = await hono.request(
      `http://t/api/plugins/servers/${SERVER}/connect?returnTo=settings`,
      { method: "POST" },
    );
    expect(started.status).toBe(200);
    const { authorizationUrl } = (await started.json()) as {
      authorizationUrl: string;
    };
    const consent = new URL(authorizationUrl);
    expect(consent.origin).toBe(fixture.origin);
    expect(consent.searchParams.get("resource")).toBe(fixture.url);
    expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
    expect(consent.searchParams.get("redirect_uri")).toBe(
      redirectUriFor(PUBLIC_URL),
    );
    expect(fixture.clients.size).toBe(1);

    // The person presses Allow; the server sends them back with a code, the state and its issuer.
    consent.searchParams.set("approve", "1");
    const allowed = await fetch(consent, { redirect: "manual" });
    expect(allowed.status).toBe(302);
    const callback = new URL(allowed.headers.get("location") ?? "");
    expect(callback.searchParams.get("iss")).toBe(fixture.origin);

    // A code whose `iss` names another authorization server is not redeemed.
    const forged = new URL(callback);
    forged.searchParams.set("iss", "https://evil.example");
    const refused = await hono.request(
      `http://t${forged.pathname}${forged.search}`,
    );
    expect(refused.headers.get("location")).toBe(
      `${APP_URL}/connections?connected=failed`,
    );

    // Back through the real callback, the code is still unspent and redeems.
    const consentAgain = new URL(authorizationUrl);
    consentAgain.searchParams.set("approve", "1");
    const allowedAgain = await fetch(consentAgain, { redirect: "manual" });
    const callbackAgain = new URL(allowedAgain.headers.get("location") ?? "");
    const back = await hono.request(
      `http://t${callbackAgain.pathname}${callbackAgain.search}`,
    );
    expect(back.headers.get("location")).toBe(
      `${APP_URL}/connections/${SERVER}`,
    );

    // Their token set is in the vault, encrypted, and nowhere else.
    const [held] = await database
      .select({ credentialId: mcpUserCredentials.credentialId })
      .from(mcpUserCredentials)
      .where(eq(mcpUserCredentials.serverId, SERVER));
    expect(held).toBeDefined();
    const [secret] = await database
      .select({
        encryptedValue: credentials.encryptedValue,
        kind: credentials.kind,
      })
      .from(credentials)
      .where(eq(credentials.id, held?.credentialId ?? ""));
    expect(secret?.kind).toBe("mcp_user_token");
    const stored = JSON.parse(
      await decryptSecret(KEY, secret?.encryptedValue ?? ""),
    ) as { accessToken: string; refreshToken: string };
    expect(fixture.accessTokens.has(stored.accessToken)).toBe(true);
    expect(stored.refreshToken).toBeTruthy();

    // Its tools were listed as the person, and every Bot was given them (personal edition).
    const listed = (await store.listServers()).find((s) => s.id === SERVER);
    expect(listed?.tools.map((tool) => tool.name).sort()).toEqual([
      "list_notes",
      "save_note",
    ]);
    expect(listed?.lastError).toBeNull();
    const offered = await store.listForAgent(botId);
    expect(
      offered.tools
        .map((tool) => tool.ref)
        .filter((ref) => ref.startsWith(`${SERVER}/`))
        .sort(),
    ).toEqual([`${SERVER}/list_notes`, `${SERVER}/save_note`]);

    // And what a Bot is told once they have: ready, not "connect it first".
    expect(await appState()).toBe("ready");

    // A Bot calls a tool, on the person's own token.
    const saved = await store.callTool({
      ref: `${SERVER}/save_note`,
      args: { text: "Buy oat milk" },
      botId,
      actorId: personId,
    });
    expect(saved.isError).toBe(false);
    expect(saved.text).toContain("Saved note #1 for test-person: Buy oat milk");
    expect(fixture.notes).toEqual(["Buy oat milk"]);

    // When the access token lapses, the refresh token renews it and the call still goes through.
    fixture.accessTokens.clear();
    const [lapsed] = await database
      .select({ credentialId: mcpUserCredentials.credentialId })
      .from(mcpUserCredentials)
      .where(eq(mcpUserCredentials.serverId, SERVER));
    const expired = JSON.stringify({ v: 1, ...stored, expiresAt: 0 });
    const { encryptSecret } = await import("../src/credentials");
    await vault.updateSecret(
      lapsed?.credentialId ?? "",
      await encryptSecret(KEY, expired),
    );
    const listedAgain = await store.callTool({
      ref: `${SERVER}/list_notes`,
      args: {},
      botId,
      actorId: personId,
    });
    expect(listedAgain.isError).toBe(false);
    expect(listedAgain.text).toContain("1. Buy oat milk");
    setEdition("team");
  });

  test("connects a server that needs no sign-in and lists its tools at once", async () => {
    process.env.OPENBOT_ALLOW_LOOPBACK_MCP = "1";
    setEdition("personal");
    const open = startOAuthMcpServer({ title: `Open ${suite}`, open: true });
    try {
      const added = await addByUrl({ title: `Open ${suite}`, url: open.url });
      expect(added.status).toBe(200);
      const { server, signIn } = (await added.json()) as {
        server: { id: string; signIn: boolean; tools: { name: string }[] };
        signIn: boolean;
      };
      expect(signIn).toBe(false);
      expect(server.signIn).toBe(false);
      expect(server.tools.map((tool) => tool.name).sort()).toEqual([
        "list_notes",
        "save_note",
      ]);
      const answered = await store.callTool({
        ref: `${server.id}/list_notes`,
        args: {},
        botId,
        actorId: personId,
      });
      expect(answered.text).toContain("anyone has no notes yet.");
    } finally {
      open.stop();
      setEdition("team");
    }
  });

  test("a key typed by somebody who isn't an admin is refused in the team edition", async () => {
    process.env.OPENBOT_ALLOW_LOOPBACK_MCP = "1";
    role = "user";
    try {
      const refused = await addByUrl({
        title: `Keyed ${suite}`,
        url: "https://mcp.example.com/mcp",
        token: "secret",
      });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: string }).error).toContain(
        "only an admin can add one",
      );
    } finally {
      role = "admin";
    }
  });
});

describe("the admin's MCP allowlist", () => {
  let controls: EnterpriseControls | undefined;
  let before: { enabled: boolean; servers: string[] } | undefined;

  beforeAll(async () => {
    setEdition("team");
    controls = await installEnterpriseControls({
      database,
      databaseUrl: testDatabaseUrl(),
      auditStore: createAuditStore(database),
      env: {},
    });
    before = (await controls.store.settings()).mcpAllowlist;
  });

  afterAll(async () => {
    if (controls && before)
      await controls.store.setSetting("mcpAllowlist", before, "test");
    await controls?.stop();
  });

  test("refuses an address that isn't approved, and adds it once an admin approves it", async () => {
    process.env.OPENBOT_ALLOW_LOOPBACK_MCP = "1";
    if (!controls) throw new Error("controls did not install");
    const second = startOAuthMcpServer({ title: `Second ${suite}` });
    try {
      await controls.store.setSetting(
        "mcpAllowlist",
        { enabled: true, servers: [] },
        "test",
      );
      await controls.refresh();

      role = "user";
      const refused = await addByUrl({
        title: `Second ${suite}`,
        url: second.url,
      });
      expect(refused.status).toBe(403);
      const body = (await refused.json()) as {
        error: string;
        code: string;
        canApprove: boolean;
      };
      expect(body.code).toBe("not-approved");
      expect(body.canApprove).toBe(false);
      expect(body.error).toContain("Ask an admin to approve it");

      // An admin approves the address, before anybody has added it.
      await controls.store.setSetting(
        "mcpAllowlist",
        { enabled: true, servers: [`${second.url}/`] },
        "test",
      );
      await controls.refresh();
      const added = await addByUrl({
        title: `Second ${suite}`,
        url: second.url,
      });
      expect(added.status).toBe(200);
      const { server } = (await added.json()) as { server: { id: string } };

      // And a call to the server added at that address is approved by the same entry.
      const check = controls.snapshot();
      expect(check?.addressApproved?.has(server.id)).toBe(true);
    } finally {
      role = "admin";
      second.stop();
    }
  });
});
