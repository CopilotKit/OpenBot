import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { decryptOAuthToken, setTokenUtil } from "better-auth/oauth2";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  exportJWK,
  generateKeyPair,
  type JWK,
  jwtVerify,
  type KeyObject,
  SignJWT,
} from "jose";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { createAuth } from "../src/auth";
import { createEntra, withEntraBearer } from "../src/auth/entra";
import { createRoleRepository } from "../src/auth/guards";
import { loadConfig } from "../src/config";
import { encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  agents,
  credentials,
  mcpServers,
  sessions,
  users,
} from "../src/db/schema";
import {
  CustomServerRefusedError,
  createPluginStore,
} from "../src/plugins/store";
import { grantedTools, REFUSAL_MARKER } from "../src/plugins/tools";
import { createRequestActor } from "../src/request-actor";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * A company system behind Microsoft Entra, reached as the signed-in person.
 *
 * Two doors in and one way out. A person's app calls OpenBot with their Entra token, and a routine
 * runs with nobody in the browser at all; either way a server an admin marked with an Entra scope is
 * called with a token Entra issued for that person through the on-behalf-of exchange.
 *
 * Entra is a stand-in that answers as Entra does: the published keys, the refresh grant with a
 * rotated refresh token, the on-behalf-of grant checked for its grant type, `requested_token_use`
 * and an assertion addressed to OpenBot, and the three refusals a person can meet (an expired
 * sign-in, missing consent, an API OpenBot's registration does not expose), in Entra's own error
 * shape. The system is a real MCP server built with the official SDK that checks the bearer it is
 * sent. Both are reached at their real addresses through `fetch`, which forwards them to 127.0.0.1.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const tag = randomUUID().slice(0, 8);

const TENANT = randomUUID();
const CLIENT_ID = randomUUID();
const CLIENT_SECRET = `secret-${tag}`;
const DOWNSTREAM_APP = randomUUID();
const HR_SCOPE = `api://${DOWNSTREAM_APP}/.default`;
const PAYROLL_SCOPE = "api://payroll/.default";
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const ENTRA_PORT = 7483;
const MCP_PORT = 7484;
const HR_HOST = `hr-${tag}.obo.test`;

const email = (name: string) => `${name}-${tag}@obo.test`;
const ADMIN = email("ada");

let signingKey: KeyObject | CryptoKey;
let publicJwk: JWK;
const KID = `kid-${tag}`;

/* ---------------------------------------------------------------- Entra, as it answers */

type Directory = {
  /** Live refresh tokens, by token: whose they are and whether Entra still honours them. */
  refreshTokens: Map<string, { oid: string; upn: string; expired?: boolean }>;
  /** Whether OpenBot's app registration exposes an API, so a token to it can be issued at all. */
  apiExposed: boolean;
  /** The systems an admin has granted OpenBot access to. */
  consented: Set<string>;
  /** Every grant the token endpoint was asked for, in order. */
  requests: { grantType: string; scope: string; assertion?: string }[];
};

const entra: Directory = {
  refreshTokens: new Map(),
  apiExposed: true,
  consented: new Set([HR_SCOPE]),
  requests: [],
};

async function sign(
  claims: Record<string, unknown>,
  options: { expiresIn?: number; key?: KeyObject | CryptoKey } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ ver: "2.0", tid: TENANT, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
    .setIssuedAt(now)
    .setNotBefore(now - 5)
    .setExpirationTime(now + (options.expiresIn ?? 3600))
    .sign(options.key ?? signingKey);
}

/** A person's token to OpenBot's own API, as Entra issues one to their app. */
const tokenToOpenBot = (
  person: { oid: string; upn: string },
  overrides: Record<string, unknown> = {},
  expiresIn?: number,
) =>
  sign(
    {
      iss: ISSUER,
      aud: CLIENT_ID,
      oid: person.oid,
      sub: `sub-${person.oid}`,
      azp: randomUUID(),
      scp: "access_as_user",
      name: person.upn.split("@")[0],
      preferred_username: person.upn,
      ...overrides,
    },
    { expiresIn },
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Entra's error body: the code, the AADSTS sentence, and the numeric codes beside it. */
const refusal = (
  status: number,
  error: string,
  code: number,
  description: string,
  extra: Record<string, unknown> = {},
) =>
  json(
    {
      error,
      error_description: `AADSTS${code}: ${description}\r\nTrace ID: ${randomUUID()}\r\nCorrelation ID: ${randomUUID()}\r\nTimestamp: 2026-10-31 12:00:00Z`,
      error_codes: [code],
      timestamp: "2026-10-31 12:00:00Z",
      trace_id: randomUUID(),
      correlation_id: randomUUID(),
      ...extra,
    },
    status,
  );

async function tokenEndpoint(request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const grantType = form.get("grant_type") ?? "";
  const scope = form.get("scope") ?? "";
  entra.requests.push({
    grantType,
    scope,
    ...(form.get("assertion")
      ? { assertion: form.get("assertion") as string }
      : {}),
  });

  if (
    form.get("client_id") !== CLIENT_ID ||
    form.get("client_secret") !== CLIENT_SECRET
  ) {
    return refusal(
      401,
      "invalid_client",
      7000215,
      "Invalid client secret provided.",
    );
  }

  if (grantType === "refresh_token") {
    const held = entra.refreshTokens.get(form.get("refresh_token") ?? "");
    if (!held) {
      return refusal(
        400,
        "invalid_grant",
        9002313,
        "Invalid request. Request is malformed or invalid.",
      );
    }
    if (held.expired) {
      return refusal(
        400,
        "invalid_grant",
        700082,
        "The refresh token has expired due to inactivity.",
      );
    }
    if (scope === `api://${CLIENT_ID}/.default` && !entra.apiExposed) {
      return refusal(
        400,
        "invalid_resource",
        500011,
        `The resource principal named api://${CLIENT_ID} was not found in the tenant named ${TENANT}.`,
      );
    }
    // Entra rotates: the new refresh token replaces the one it was shown.
    const rotated = `rt-${randomUUID()}`;
    entra.refreshTokens.delete(form.get("refresh_token") ?? "");
    entra.refreshTokens.set(rotated, { oid: held.oid, upn: held.upn });
    return json({
      token_type: "Bearer",
      scope: `api://${CLIENT_ID}/access_as_user`,
      expires_in: 3599,
      ext_expires_in: 3599,
      access_token: await tokenToOpenBot(held),
      refresh_token: rotated,
    });
  }

  if (grantType === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
    if (form.get("requested_token_use") !== "on_behalf_of") {
      return refusal(
        400,
        "invalid_request",
        900144,
        "The request body must contain the following parameter: 'requested_token_use'.",
      );
    }
    let person: { oid: string; upn: string };
    try {
      // The assertion must be addressed to the app making this request, and signed by Entra.
      const { payload } = await jwtVerify(
        form.get("assertion") ?? "",
        async () => publicJwk,
        { issuer: ISSUER, audience: CLIENT_ID },
      );
      person = {
        oid: payload.oid as string,
        upn: payload.preferred_username as string,
      };
    } catch {
      return refusal(
        400,
        "invalid_grant",
        500131,
        "Assertion audience does not match the Client app presenting the assertion.",
      );
    }
    if (!entra.consented.has(scope)) {
      return refusal(
        400,
        "invalid_grant",
        65001,
        `The user or administrator has not consented to use the application with ID '${CLIENT_ID}' named 'OpenBot'. Send an interactive authorization request for this user and resource.`,
        { suberror: "consent_required" },
      );
    }
    return json({
      token_type: "Bearer",
      scope: `api://${DOWNSTREAM_APP}/read`,
      expires_in: 3599,
      ext_expires_in: 3599,
      access_token: await sign({
        iss: ISSUER,
        aud: DOWNSTREAM_APP,
        oid: person.oid,
        azp: CLIENT_ID,
        scp: "read",
        preferred_username: person.upn,
      }),
    });
  }

  return refusal(
    400,
    "unsupported_grant_type",
    70003,
    "The app requested an unsupported grant type.",
  );
}

/* ------------------------------------------------- the company's system, as MCP */

/** Every bearer the system accepted, as the person it named. */
const reached: string[] = [];

async function hrSystem(request: Request): Promise<Response> {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
  let who: string;
  try {
    // What a system behind Entra checks: Entra's signature, the directory, and itself as audience.
    const { payload } = await jwtVerify(bearer ?? "", async () => publicJwk, {
      issuer: ISSUER,
      audience: DOWNSTREAM_APP,
    });
    who = payload.preferred_username as string;
  } catch {
    // The deployment's own token, for the server added without a scope.
    if (bearer === `deployment-token-${tag}`) who = "the deployment";
    else return new Response("Unauthorized", { status: 401 });
  }
  const server = new McpServer({ name: "hr", version: "1.0.0" });
  server.registerTool(
    "whoami",
    { description: "Who this HR system sees calling it." },
    async () => {
      reached.push(who);
      return { content: [{ type: "text", text: `You are ${who}.` }] };
    },
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return await transport.handleRequest(request);
}

let entraServer: ReturnType<typeof Bun.serve>;
let mcpServer: ReturnType<typeof Bun.serve>;
const realFetch = globalThis.fetch;

/* ---------------------------------------------------------------- OpenBot */

const config = loadConfig(
  testEnvironment({
    MICROSOFT_OAUTH_CLIENT_ID: CLIENT_ID,
    MICROSOFT_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    MICROSOFT_OAUTH_TENANT_ID: TENANT,
    BETTER_AUTH_URL: "http://127.0.0.1:7480",
    INITIAL_ADMIN_EMAILS: ADMIN,
  }),
);
const authConfig = config.auth;
const microsoft = authConfig?.microsoft;
if (!authConfig || !microsoft) throw new Error("Microsoft sign-in is set up");

const auditStore = createAuditStore(database);
/** Every instance below, so Better Auth's sign-in can ask whichever one started it, as index.ts wires it. */
const instances: ReturnType<typeof createEntra>[] = [];
const betterAuth = createAuth(config, database, undefined, auditStore, {
  vouchesForMicrosoftToken: (token) =>
    instances.some((instance) => instance.vouches(token)),
});
const newEntra = () => {
  const instance = createEntra({
    microsoft,
    authConfig,
    auth: betterAuth,
    database,
  });
  instances.push(instance);
  return instance;
};
const signIn = newEntra();

const credentialReader = {
  readSecret: async (id: string) => {
    const [row] = await database
      .select({
        encryptedValue: credentials.encryptedValue,
        revokedAt: credentials.revokedAt,
      })
      .from(credentials)
      .where(eq(credentials.id, id));
    return row ?? null;
  },
} as never;

const storeWith = (tokens?: ReturnType<typeof createEntra>) =>
  createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore,
    credentials: credentialReader,
    encryptionKey: config.keyEncryptionKey,
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    ...(tokens ? { entra: tokens } : {}),
  });

const store = storeWith(signIn);

function build() {
  const args = new Array(createApp.length) as unknown as Parameters<
    typeof createApp
  >;
  args[0] = config;
  args[1] = withEntraBearer(betterAuth, signIn);
  args[2] = createRoleRepository(database);
  args[12] = auditStore;
  args[14] = store;
  return createApp(...args);
}

const app = build();
const api = (path: string, token: string | null, body?: unknown) =>
  app.request(`http://127.0.0.1:7480/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const person = (name: string) => ({ oid: randomUUID(), upn: email(name) });
const ada = person("ada");
const alice = person("alice");
const bob = person("bob");
const cara = person("cara");

const SERVER = `obo-hr-${tag}`;
const PAYROLL = `obo-payroll-${tag}`;
const PLAIN = `obo-plain-${tag}`;
const BOT = `obo-bot-${tag}`;
const DEPLOYMENT_CREDENTIAL = randomUUID();

async function userId(address: string) {
  const [row] = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, address));
  return row?.id ?? null;
}

/**
 * How a person who signed in with Microsoft in their browser is left: a user and a Microsoft account
 * from that sign-in, holding their refresh token encrypted the way Better Auth writes it.
 *
 * The user and account come from the real first sign-in (a separate instance, so the token it saw is
 * not remembered by the one under test); the refresh token is what a browser's sign-in adds.
 */
async function signedInWithMicrosoft(who: { oid: string; upn: string }) {
  await newEntra().sessionFrom(
    new Headers({ authorization: `Bearer ${await tokenToOpenBot(who)}` }),
  );
  const id = await userId(who.upn);
  if (!id) throw new Error(`${who.upn} was signed in`);
  const [account] = await database
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, id), eq(accounts.providerId, "microsoft")));
  if (!account) throw new Error(`${who.upn} has a Microsoft account`);
  const ctx = (await betterAuth.$context) as unknown as Parameters<
    typeof setTokenUtil
  >[1];
  const refreshToken = `rt-${randomUUID()}`;
  entra.refreshTokens.set(refreshToken, who);
  await ctx.internalAdapter.updateAccount(account.id, {
    refreshToken: (await setTokenUtil(refreshToken, ctx)) as string,
  });
  return id;
}

async function storedRefreshToken(id: string) {
  const ctx = (await betterAuth.$context) as unknown as Parameters<
    typeof decryptOAuthToken
  >[1];
  const [row] = await database
    .select({ refreshToken: accounts.refreshToken })
    .from(accounts)
    .where(and(eq(accounts.userId, id), eq(accounts.providerId, "microsoft")));
  return {
    raw: row?.refreshToken ?? null,
    plain: row?.refreshToken
      ? await decryptOAuthToken(row.refreshToken, ctx)
      : null,
  };
}

/** One tool call from a routine: the in-process door a background run takes, with nobody watching. */
async function backgroundCall(
  tokens: ReturnType<typeof createEntra>,
  actorId: string,
  serverId = SERVER,
) {
  const [tool] = (
    await grantedTools({
      store: storeWith(tokens),
      botId: BOT,
      actorId,
      initiator: { kind: "routine", id: `routine-${tag}` },
    })
  ).filter((granted) => granted.ref === `${serverId}/whoami`);
  if (!tool) throw new Error(`the Bot holds ${serverId}/whoami`);
  return String(await tool.execute({}));
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  // As Entra publishes its keys: a kid and a use, and no `alg`.
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, use: "sig" };

  entraServer = Bun.serve({
    hostname: "127.0.0.1",
    port: ENTRA_PORT,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname.endsWith("/discovery/v2.0/keys"))
        return json({ keys: [publicJwk] });
      if (pathname.endsWith("/oauth2/v2.0/token"))
        return await tokenEndpoint(request);
      return new Response("Not found", { status: 404 });
    },
  });
  mcpServer = Bun.serve({
    hostname: "127.0.0.1",
    port: MCP_PORT,
    fetch: hrSystem,
  });

  // Entra and the HR system at their real addresses, answered on 127.0.0.1.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(input as string, init);
    const url = new URL(request.url);
    const port =
      url.hostname === "login.microsoftonline.com"
        ? ENTRA_PORT
        : url.hostname === HR_HOST
          ? MCP_PORT
          : null;
    if (port === null) return realFetch(request);
    const local = new URL(
      `${url.pathname}${url.search}`,
      `http://127.0.0.1:${port}`,
    );
    return realFetch(new Request(local, request));
  }) as typeof fetch;

  await database
    .insert(agents)
    .values({ id: BOT, name: BOT, type: "remote_ag_ui", configuration: {} });
  await database.insert(credentials).values({
    id: DEPLOYMENT_CREDENTIAL,
    kind: "mcp",
    provider: PLAIN,
    keyId: `mcp-${PLAIN}`,
    encryptedValue: await encryptSecret(
      config.keyEncryptionKey,
      `deployment-token-${tag}`,
    ),
    metadata: {},
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  entraServer?.stop(true);
  mcpServer?.stop(true);
  await database.delete(mcpServers).where(like(mcpServers.id, `obo-%-${tag}`));
  await database.delete(agents).where(eq(agents.id, BOT));
  await database
    .delete(credentials)
    .where(inArray(credentials.id, [DEPLOYMENT_CREDENTIAL]));
  await database.delete(users).where(like(users.email, `%-${tag}@obo.test`));
  await database.$client.end({ timeout: 5 });
});

/* ---------------------------------------------------------------- the tests */

describe("an app calls OpenBot with a person's Entra token", () => {
  test("a valid token runs as that person, signed in the way the sign-in screen signs them in", async () => {
    const response = await api("/me", await tokenToOpenBot(ada));
    expect(response.status).toBe(200);
    const { user } = (await response.json()) as {
      user: { email: string; role: string };
    };
    expect(user.email).toBe(ADMIN);
    // Admitted by the same rules: INITIAL_ADMIN_EMAILS names her, so sign-in made her an admin.
    expect(user.role).toBe("admin");

    // And the second request finds her rather than signing her in again.
    const again = await api("/me", await tokenToOpenBot(ada));
    expect(again.status).toBe(200);
    const signedIn = await database
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, (await userId(ADMIN)) ?? ""));
    expect(signedIn).toHaveLength(1);
  });

  test("an agent request with the token runs as that person too", async () => {
    const door = withEntraBearer(betterAuth, signIn);
    const { resolveRequestActor } = createRequestActor({
      singleUser: false,
      getSession: (headers) => door.api.getSession({ headers }),
      rolesForUser: (id) => createRoleRepository(database).rolesForUser(id),
    });
    const actor = await resolveRequestActor(
      new Request("http://127.0.0.1:7480/api/copilotkit", {
        method: "POST",
        headers: { authorization: `Bearer ${await tokenToOpenBot(ada)}` },
      }),
    );
    expect(actor).toEqual({
      id: (await userId(ADMIN)) ?? "",
      name: ada.upn.split("@")[0],
      role: "admin",
    });
  });

  test.each([
    ["a token for another audience", { aud: randomUUID() }, undefined],
    [
      "a token from another directory",
      { iss: `https://login.microsoftonline.com/${randomUUID()}/v2.0` },
      undefined,
    ],
    ["an expired token", {}, -60],
    [
      "an app's own token, with no person behind it",
      { scp: undefined },
      undefined,
    ],
  ] as const)("%s is refused", async (_name, overrides, expiresIn) => {
    const stranger = person("stranger");
    const response = await api(
      "/me",
      await tokenToOpenBot(stranger, overrides, expiresIn),
    );
    expect(response.status).toBe(401);
    // Nobody was signed in on its strength.
    expect(await userId(stranger.upn)).toBeNull();
  });

  test("the token does not sign anybody in at Better Auth's own endpoint", async () => {
    // The first sign-in from a token is answered for the bearer path only; this door stays shut.
    const response = await app.request(
      "http://127.0.0.1:7480/api/auth/sign-in/social",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "microsoft",
          idToken: { token: await tokenToOpenBot(person("door")) },
        }),
      },
    );
    expect(response.status).toBe(401);
    expect(await userId(email("door"))).toBeNull();
  });

  test("a token signed by anybody but Entra is refused", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const forged = await sign(
      {
        iss: ISSUER,
        aud: CLIENT_ID,
        oid: ada.oid,
        scp: "access_as_user",
        preferred_username: ADMIN,
      },
      { key: privateKey },
    );
    expect((await api("/me", forged)).status).toBe(401);
  });

  test("an admin marks a server as reached as the signed-in person, and it is asked what it offers as them", async () => {
    const response = await api(
      "/plugins/servers/custom",
      await tokenToOpenBot(ada),
      {
        id: SERVER,
        title: "HR",
        url: `https://${HR_HOST}/mcp`,
        entraScope: HR_SCOPE,
      },
    );
    expect(response.status).toBe(200);
    const { server } = (await response.json()) as {
      server: {
        entraScope: string;
        tools: { ref: string }[];
        lastError: string | null;
      };
    };
    expect(server.entraScope).toBe(HR_SCOPE);
    expect(server.lastError).toBeNull();
    expect(server.tools.map((tool) => tool.ref)).toEqual([`${SERVER}/whoami`]);
    expect(reached).toEqual([]);
    await store.grant("mcp", `${SERVER}/whoami`, BOT, ADMIN);
  });

  test("two people each reach the system as themselves, on the token their app sent", async () => {
    const aliceToken = await tokenToOpenBot(alice);
    const bobToken = await tokenToOpenBot(bob);
    const asked = entra.requests.length;

    const forAlice = await api("/plugins/call", aliceToken, {
      ref: `${SERVER}/whoami`,
      agentId: BOT,
      args: {},
    });
    const forBob = await api("/plugins/call", bobToken, {
      ref: `${SERVER}/whoami`,
      agentId: BOT,
      args: {},
    });

    expect(forAlice.status).toBe(200);
    expect(((await forAlice.json()) as { text: string }).text).toContain(
      `You are ${alice.upn}.`,
    );
    expect(forBob.status).toBe(200);
    expect(((await forBob.json()) as { text: string }).text).toContain(
      `You are ${bob.upn}.`,
    );

    // On behalf of each, with the token each one's app sent as the assertion.
    expect(entra.requests.slice(asked)).toEqual([
      {
        grantType: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        scope: HR_SCOPE,
        assertion: aliceToken,
      },
      {
        grantType: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        scope: HR_SCOPE,
        assertion: bobToken,
      },
    ]);
  });

  test("a second call reuses the person's token until it is close to expiring", async () => {
    const asked = entra.requests.length;
    const response = await api("/plugins/call", await tokenToOpenBot(alice), {
      ref: `${SERVER}/whoami`,
      agentId: BOT,
      args: {},
    });
    expect(((await response.json()) as { text: string }).text).toContain(
      `You are ${alice.upn}.`,
    );
    expect(entra.requests.length).toBe(asked);
  });
});

describe("a routine reaches the system as its person, with nobody in the browser", () => {
  test("the token is minted from the person's stored Microsoft sign-in, and the rotated refresh token is stored back", async () => {
    const caraId = await signedInWithMicrosoft(cara);
    const before = await storedRefreshToken(caraId);
    const asked = entra.requests.length;

    // A fresh instance has seen no token from anybody's app: this is the stored sign-in alone.
    const answer = await backgroundCall(newEntra(), caraId);
    expect(answer).toContain(`You are ${cara.upn}.`);

    const grants = entra.requests.slice(asked);
    expect(
      grants.map(({ grantType, scope }) => ({ grantType, scope })),
    ).toEqual([
      { grantType: "refresh_token", scope: `api://${CLIENT_ID}/.default` },
      {
        grantType: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        scope: HR_SCOPE,
      },
    ]);

    const after = await storedRefreshToken(caraId);
    expect(after.plain).not.toBe(before.plain);
    // The one Entra now honours, and still encrypted the way Better Auth writes it.
    expect(entra.refreshTokens.get(after.plain ?? "")?.oid).toBe(cara.oid);
    expect(after.raw).not.toBe(after.plain);
  });

  test("a person who never signed in with Microsoft is told so", async () => {
    // Somebody who came in another way, a directory sync say, and has no Microsoft account here.
    const danId = randomUUID();
    await database
      .insert(users)
      .values({ id: danId, email: email("dan"), name: "dan" });
    expect(await backgroundCall(newEntra(), danId)).toBe(
      `${REFUSAL_MARKER} HR uses your Microsoft account, and you haven't signed in to OpenBot with Microsoft. Sign in with Microsoft and ask again.`,
    );
  });

  test("an expired Microsoft sign-in is told to sign in again", async () => {
    const eve = person("eve");
    const eveId = await signedInWithMicrosoft(eve);
    for (const held of entra.refreshTokens.values())
      if (held.oid === eve.oid) held.expired = true;
    expect(await backgroundCall(newEntra(), eveId)).toBe(
      `${REFUSAL_MARKER} Your Microsoft sign-in has expired, so HR wasn't used. Sign in with Microsoft again and ask again.`,
    );
  });

  test("a system an admin has not granted OpenBot access to in Entra says so", async () => {
    // Added while access was granted, so its tools are known; then an admin withdraws it in Entra.
    entra.consented.add(PAYROLL_SCOPE);
    await store.addCustomServer({
      id: PAYROLL,
      title: "Payroll",
      url: `https://${HR_HOST}/mcp`,
      entraScope: PAYROLL_SCOPE,
      by: ADMIN,
      actorId: (await userId(ADMIN)) ?? "",
    });
    await store.grant("mcp", `${PAYROLL}/whoami`, BOT, ADMIN);
    entra.consented.delete(PAYROLL_SCOPE);

    const fayId = await signedInWithMicrosoft(person("fay"));
    expect(await backgroundCall(newEntra(), fayId, PAYROLL)).toBe(
      `${REFUSAL_MARKER} An admin hasn't given OpenBot access to Payroll in Microsoft Entra. Ask an admin to grant it.`,
    );
  });

  test("an app registration that exposes no API says so", async () => {
    const gus = person("gus");
    const gusId = await signedInWithMicrosoft(gus);
    entra.apiExposed = false;
    try {
      expect(await backgroundCall(newEntra(), gusId)).toBe(
        `${REFUSAL_MARKER} OpenBot isn't set up in Microsoft Entra to reach HR as you. Ask an admin to expose OpenBot's API there.`,
      );
    } finally {
      entra.apiExposed = true;
    }
  });
});

describe("what does not change", () => {
  test("a server added without a scope is still reached on the deployment's own token", async () => {
    const added = await store.addCustomServer({
      id: PLAIN,
      title: "Plain",
      url: `https://${HR_HOST}/mcp`,
      credentialId: DEPLOYMENT_CREDENTIAL,
      by: ADMIN,
    });
    expect(added.entraScope).toBeNull();
    await store.grant("mcp", `${PLAIN}/whoami`, BOT, ADMIN);
    const asked = entra.requests.length;
    const caraId = (await userId(cara.upn)) ?? "";
    expect(await backgroundCall(newEntra(), caraId, PLAIN)).toContain(
      "You are the deployment.",
    );
    expect(entra.requests.length).toBe(asked);
  });

  test("a server cannot be marked this way where Microsoft sign-in is not set up", async () => {
    const id = `obo-unset-${tag}`;
    await expect(
      storeWith().addCustomServer({
        id,
        title: "Unset",
        url: `https://${HR_HOST}/mcp`,
        entraScope: HR_SCOPE,
        by: ADMIN,
      }),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);
    const [row] = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.id, id));
    expect(row).toBeUndefined();
  });
});
