import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type ExchangeResponse,
  RECORDER_AUTHORITY_UNAVAILABLE,
  RECORDER_SIGNED_OUT,
} from "@openbot/shared/recorder-api";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import {
  createOrganizationAuth,
  ORGANIZATION_SESSION_MAX_AGE_SECONDS,
} from "../src/auth/organization";
import { organizationUserStore } from "../src/auth/organization-store";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { recorderConnections } from "../src/db/schema/recorder";
import { clearDesktopConnectionFailure } from "../src/desktop-connection-failure";
import { createRecorderExtension } from "../src/recorder/wiring";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `recorder-organization-${randomUUID()}`;
const person = {
  id: `${prefix}-person`,
  email: `${prefix}@example.test`,
  name: "Organization Person",
  image: null,
  role: "user" as const,
};
const ORIGIN = `chrome-extension://${RECORDER_EXTENSION_ID}`;
const APP = "http://127.0.0.1:3010";
const HOST_TOKEN = "recorder-organization-host-token";
const SESSION_COOKIE = "better-auth.session_token=fixture-session";

type Answer = () => Response | Promise<Response>;
const signedIn: Answer = () => Response.json({ user: person });
let answer: Answer = signedIn;
const authorityFetch = (request: Request) => {
  expect(new URL(request.url).pathname).toBe("/api/me");
  if (request.headers.get("cookie") !== SESSION_COOKIE)
    return new Response(null, { status: 401 });
  return answer();
};
let authority = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: authorityFetch,
});
const authorityPort = authority.port;

// The sign-in verdict is cached for 60 s per connection by the guard's clock, which defaults to the
// Date.now captured when the resolver is built: build it after this wrapper is installed.
const realNow = Date.now;
let skewMs = 0;
const pastTheCache = () => {
  skewMs += 61_000;
};

const config = loadConfig({
  DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:5432/openbot",
  KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  INTELLIGENCE_API_URL: "http://127.0.0.1:7100",
  INTELLIGENCE_GATEWAY_WS_URL: "ws://127.0.0.1:7103",
  INTELLIGENCE_API_KEY: "tenant-api-key",
  COPILOTKIT_LICENSE_TOKEN: "license-token",
  OPENBOT_ORGANIZATION_AUTH_URL: `http://127.0.0.1:${authorityPort}`,
});
const auditStore = {
  insert: async (_event: AuditEventInput) => {},
};
const roleRepository = { rolesForUser: async () => ["user" as const] };

let app: ReturnType<typeof createApp>;

const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const { json, headers, ...rest } = init;
  return app.request(`${APP}${path}`, {
    ...rest,
    headers: {
      ...(json === undefined ? {} : { "content-type": "application/json" }),
      ...(headers as Record<string, string>),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
};
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const desktopFailure = async () =>
  (
    await call("/api/desktop/connection-failure", {
      headers: { "x-openbot-desktop-host-token": HOST_TOKEN },
    })
  ).json();

/** The real handoff: the authority cookie becomes the local organization cookie. */
async function organizationCookie() {
  const start = await call("/api/auth/organization/session", {
    method: "POST",
    headers: { origin: APP },
    json: { cookie: SESSION_COOKIE },
  });
  expect(start.status).toBe(200);
  const { ticket } = (await start.json()) as { ticket: string };
  const consumed = await call(
    `/api/auth/organization/session?ticket=${ticket}`,
  );
  expect(consumed.status).toBe(303);
  const cookie = consumed.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toStartWith("openbot.organization-session=");
  return cookie as string;
}

async function connect(cookie: string, installId: string) {
  const minted = await call("/api/recorder/connect-codes", {
    method: "POST",
    headers: { cookie },
    json: { via: "web" },
  });
  expect(minted.status).toBe(201);
  const { code } = (await minted.json()) as { code: string };
  const exchanged = await call("/api/recorder/connections", {
    method: "POST",
    headers: { origin: ORIGIN },
    json: { code, label: "Chrome on macOS", installId },
  });
  expect(exchanged.status).toBe(201);
  return (await exchanged.json()) as ExchangeResponse;
}

const clearOrganizationFailure = () =>
  clearDesktopConnectionFailure("organization");
beforeEach(() => {
  clearOrganizationFailure();
  answer = signedIn;
});
afterEach(clearOrganizationFailure);

beforeAll(() => {
  Date.now = () => realNow() + skewMs;
  const organizationAuth = createOrganizationAuth({
    authorityUrl: config.organizationAuthUrl as string,
    materializeUser: organizationUserStore(database),
  });
  const recorder = createRecorderExtension({
    config,
    database,
    organizationAuth,
    roleRepository,
    peopleStore: { isRevoked: async () => false },
    personalSpaces: {
      containerFor: (userId) => `space-of-${userId}`,
      state: async () => ({ state: "unassigned", containerId: null }),
      kick: () => {},
    },
    auditStore,
  });
  /*
   * createApp is positional. Placed by index rather than after a spread of `undefined`s, whose
   * length TypeScript cannot see, so each dependency is type-checked against the parameter it
   * lands on.
   */
  const args = new Array(createApp.length) as unknown as Parameters<
    typeof createApp
  >;
  args[0] = config;
  args[1] = organizationAuth;
  args[2] = roleRepository;
  args[12] = auditStore;
  args[27] = HOST_TOKEN;
  args[34] = { recorder };
  app = createApp(...args);
});
afterAll(async () => {
  Date.now = realNow;
  authority.stop(true);
  await database.delete(users).where(eq(users.email, person.email));
  await database.$client.close();
});

test("an odd answer from the organization's sign-in server never signs the Recorder out, and a 401 or 403 does", async () => {
  const cookie = await organizationCookie();
  const { token } = await connect(cookie, "a".repeat(32));
  const me = () => call("/api/recorder/me", { headers: bearer(token) });
  expect((await me()).status).toBe(200);

  const odd: Array<[string, Answer]> = [
    ["404", () => new Response("missing", { status: 404 })],
    ["408", () => new Response(null, { status: 408 })],
    ["429", () => new Response(null, { status: 429 })],
    [
      "302",
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:1/login" },
        }),
    ],
    ["200 that is not JSON", () => new Response("<html>sign in</html>")],
    ["200 that is not an actor", () => Response.json({ user: { id: 7 } })],
    ["503", () => new Response(null, { status: 503 })],
  ];
  for (const [label, odd_answer] of odd) {
    pastTheCache();
    answer = odd_answer;
    const refused = await me();
    expect(refused.status, label).toBe(503);
    expect(await refused.json(), label).toEqual({
      error: "Your organization could not answer. Try again in a moment.",
      code: RECORDER_AUTHORITY_UNAVAILABLE,
    });
    answer = signedIn;
    expect((await me()).status, `${label}, then answering again`).toBe(200);
  }

  // A closed port: the sign-in server is not there at all.
  pastTheCache();
  authority.stop(true);
  const closed = await me();
  expect(closed.status).toBe(503);
  expect(((await closed.json()) as { code: string }).code).toBe(
    RECORDER_AUTHORITY_UNAVAILABLE,
  );
  authority = Bun.serve({
    hostname: "127.0.0.1",
    port: authorityPort,
    fetch: authorityFetch,
  });
  expect((await me()).status).toBe(200);

  // Only an explicit refusal signs the Recorder out, 401 and 403 alike.
  for (const status of [401, 403]) {
    pastTheCache();
    answer = () => new Response(null, { status });
    const signedOut = await me();
    expect(signedOut.status, String(status)).toBe(401);
    expect(await signedOut.json(), String(status)).toMatchObject({
      code: RECORDER_SIGNED_OUT,
      reason: "organization",
    });
    answer = signedIn;
    pastTheCache();
    expect((await me()).status, `after ${status}`).toBe(200);
  }
});

test("a person the organization removed is refused once the cached answer ages out, and the re-check leaves Desktop's failure state alone", async () => {
  const cookie = await organizationCookie();
  const { token } = await connect(cookie, "b".repeat(32));
  const me = () => call("/api/recorder/me", { headers: bearer(token) });
  expect((await me()).status).toBe(200);

  answer = () => new Response(null, { status: 401 });
  // Still inside the 60 s cache: the earlier answer stands.
  expect((await me()).status).toBe(200);
  pastTheCache();
  expect(await desktopFailure()).toBeNull();
  const removed = await me();
  expect(removed.status).toBe(401);
  expect(await removed.json()).toMatchObject({
    code: RECORDER_SIGNED_OUT,
    reason: "organization",
  });
  // The Recorder's own re-check records no Desktop connection failure.
  expect(await desktopFailure()).toBeNull();

  // The same removed person asking with their cookie is today's recorded failure, unchanged.
  const withCookie = await call("/api/recorder/connections", {
    headers: { cookie },
  });
  expect(withCookie.status).toBe(401);
  expect(await desktopFailure()).toEqual({
    connection: "organization",
    code: "organization_authentication_failed",
  });
});

test("the stored organization session is sealed, never the raw cookie", async () => {
  const cookie = await organizationCookie();
  const { connection } = await connect(cookie, "c".repeat(32));
  const [row] = await database
    .select({ sealed: recorderConnections.organizationSession })
    .from(recorderConnections)
    .where(eq(recorderConnections.id, connection.id));
  expect(row?.sealed).toBeTruthy();
  const value = cookie.slice("openbot.organization-session=".length);
  expect(row?.sealed).not.toContain(value);
  expect(row?.sealed).not.toContain("better-auth.session_token");
  expect(row?.sealed).not.toContain(cookie);
});

test("a connection lasts no longer than the organization session cookie it carries a copy of, however much it is used", async () => {
  const cookie = await organizationCookie();
  const { token, connection } = await connect(cookie, "d".repeat(32));
  const me = () => call("/api/recorder/me", { headers: bearer(token) });
  expect((await me()).status).toBe(200);
  // Made a minute short of the cookie's Max-Age ago, and used just now: it still stands. On the real clock, which the
  // store reads: `Date.now` is skewed here for the guard's cache.
  const madeAgo = async (ms: number) => {
    await database
      .update(recorderConnections)
      .set({ createdAt: new Date(realNow() - ms), lastUsedAt: new Date() })
      .where(eq(recorderConnections.id, connection.id));
  };
  await madeAgo(ORGANIZATION_SESSION_MAX_AGE_SECONDS * 1_000 - 60_000);
  expect((await me()).status).toBe(200);
  // A minute past it: the browser that held the cookie no longer would, and nor does the connection.
  await madeAgo(ORGANIZATION_SESSION_MAX_AGE_SECONDS * 1_000 + 60_000);
  const expired = await me();
  expect(expired.status).toBe(401);
  expect(await expired.json()).toMatchObject({ code: RECORDER_SIGNED_OUT });
});
