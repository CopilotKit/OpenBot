import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createAuth, sessionLifetimeMs } from "../src/auth";
import { SIGN_OUT_UNFINISHED } from "../src/auth/organization";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { sessions, users } from "../src/db/schema/core";
import { createRecorderExtension } from "../src/recorder/wiring";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { SESSION_LIFETIME_MS, testEnvironment } from "./support/environment";

/*
 * A person's sign-in ending ends their Recorders with it, through the real Better Auth routes and the Recorder's own
 * guard: what index.ts wires, built here the same way (index.ts cannot be imported by a test). A sign-out, and every
 * other way Better Auth ends a live session; and when the Recorders cannot be ended, the session is not ended either.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `recorder-sign-out-${randomUUID()}`;
const person = `${prefix}-person`;
const other = `${prefix}-other`;
const BASE = "http://127.0.0.1:3999";

const config = loadConfig(testEnvironment({ BETTER_AUTH_URL: BASE }));
const audits: AuditEventInput[] = [];
const auditStore = {
  insert: async (event: AuditEventInput) => {
    audits.push(event);
  },
};
const roleRepository = { rolesForUser: async () => ["user" as const] };

/** The Recorder's wiring, as index.ts builds it, with the trail its connections' rows go to. */
function recorderWith(auditFor?: () => AuditStore) {
  return createRecorderExtension({
    config,
    database,
    organizationAuth: undefined,
    roleRepository,
    peopleStore: { isRevoked: async () => false },
    personalSpaces: {
      containerFor: (userId) => `space-of-${userId}`,
      state: async () => ({ state: "unassigned", containerId: null }),
      kick: () => {},
    },
    auditStore,
    sessionLifetimeMs: SESSION_LIFETIME_MS,
    ...(auditFor ? { auditFor } : {}),
  });
}
/** A trail that refuses every row a connection's change writes, `times` times, then takes them. */
function refusing(times = Number.POSITIVE_INFINITY): () => AuditStore {
  let refused = 0;
  return () => ({
    insert: async (event) => {
      if (refused < times) {
        refused += 1;
        throw new Error("the audit trail is unavailable");
      }
      audits.push(event);
    },
  });
}

const working = recorderWith();
// As index.ts: the auth is built before the Recorder's wiring, and reaches it only once something ends.
let recorder = working;
const auth = createAuth(config, database, undefined, undefined, {
  signOutRecorders: (userId, ending) => recorder.signOut(userId, ending),
});

let app: ReturnType<typeof createApp>;
let cookieName: string;

beforeAll(async () => {
  await database.insert(users).values([
    { id: person, email: `${person}@example.test`, name: "Leaving" },
    { id: other, email: `${other}@example.test`, name: "Staying" },
  ]);
  const args = new Array(createApp.length) as unknown as Parameters<
    typeof createApp
  >;
  args[0] = config;
  args[1] = auth as never;
  args[2] = roleRepository;
  args[12] = auditStore;
  args[34] = { recorder: working };
  app = createApp(...args);
  cookieName = (await auth.$context).authCookies.sessionToken.name;
});
beforeEach(async () => {
  recorder = working;
  audits.length = 0;
  await database
    .delete(sessions)
    .where(inArray(sessions.userId, [person, other]));
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [person, other]));
  await database.$client.close();
});

/** A session row as Better Auth writes one, and the signed cookie its browser holds (better-call's HMAC-SHA256). */
async function signIn(
  userId: string,
  expiresAt = new Date(Date.now() + 3_600_000),
) {
  const token = randomUUID().replaceAll("-", "");
  await database.insert(sessions).values({
    id: randomUUID(),
    userId,
    token,
    expiresAt,
  });
  const signature = createHmac("sha256", config.auth?.secret as string)
    .update(token)
    .digest("base64");
  return {
    token,
    cookie: `${cookieName}=${encodeURIComponent(`${token}.${signature}`)}`,
  };
}

/** A browser connected as this person, the way the Recorder connects one. */
async function connect(userId: string, installId: string) {
  const minted = await working.connections.mintCode(userId, "web");
  const made = await working.connections.exchange({
    code: minted!.code,
    label: "Chrome on macOS",
    extensionId: RECORDER_EXTENSION_ID,
    installId,
  });
  return made!;
}

const me = async (token: string) =>
  (
    await app.request(`${BASE}/api/recorder/me`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).status;

/** A Better Auth route, as the app calls it: POST, JSON, from the app's own origin, signed in by `cookie`. */
const post = (path: string, cookie: string, body: unknown = {}) =>
  app.request(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: { cookie, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const sessionsOf = async (userId: string) =>
  (
    await database
      .select({ token: sessions.token })
      .from(sessions)
      .where(eq(sessions.userId, userId))
  ).map((row) => row.token);

/** The `recorder.revoked` rows for these connections: how each ended. */
const endings = (...connectionIds: string[]) =>
  audits
    .filter(
      (event) =>
        event.eventType === "recorder.revoked" &&
        connectionIds.includes(event.targetId ?? ""),
    )
    .map((event) => [
      event.targetId,
      event.payload.reason,
      event.payload.ending,
    ])
    .sort();

test("signing out of OpenBot signs every Recorder connected as that person out, and nobody else's", async () => {
  const chrome = await connect(person, "c".repeat(32));
  const edge = await connect(person, "e".repeat(32));
  const theirs = await connect(other, "c".repeat(32));
  const { cookie } = await signIn(person);
  expect(await me(chrome.token)).toBe(200);

  expect((await post("/sign-out", cookie)).status).toBe(200);

  expect(await me(chrome.token)).toBe(401);
  expect(await me(edge.token)).toBe(401);
  expect(await me(theirs.token)).toBe(200);
  expect(endings(chrome.connection.id, edge.connection.id)).toEqual(
    [
      [chrome.connection.id, "signed_out", "/sign-out"],
      [edge.connection.id, "signed_out", "/sign-out"],
    ].sort(),
  );
});

test("a sign-out whose Recorders cannot be ended does not happen: the person is told, still signed in, and the trail says so", async () => {
  recorder = recorderWith(refusing());
  const chrome = await connect(person, "1".repeat(32));
  const { cookie, token } = await signIn(person);

  const refused = await post("/sign-out", cookie);
  expect(refused.status).toBe(503);
  expect(((await refused.json()) as { message: string }).message).toBe(
    SIGN_OUT_UNFINISHED,
  );
  // Nothing ended: the session, the cookie, and the Recorder.
  expect(await sessionsOf(person)).toEqual([token]);
  expect(refused.headers.get("set-cookie") ?? "").not.toContain(
    `${cookieName}=;`,
  );
  expect(await me(chrome.token)).toBe(200);
  // Tried three times, then the security row.
  expect(
    audits.filter((event) => event.eventType === "recorder.sign_out_failed"),
  ).toEqual([
    {
      eventType: "recorder.sign_out_failed",
      targetType: "person",
      targetId: person,
      initiator: { kind: "deployment" },
      payload: {
        ending: "/sign-out",
        attempts: 3,
        error: "the audit trail is unavailable",
      },
    },
  ]);

  // Once the trail is back, signing out again does it all.
  recorder = working;
  expect((await post("/sign-out", cookie)).status).toBe(200);
  expect(await sessionsOf(person)).toEqual([]);
  expect(await me(chrome.token)).toBe(401);
});

test("a failure that clears on a retry still signs out, with no security row", async () => {
  recorder = recorderWith(refusing(1));
  const chrome = await connect(person, "2".repeat(32));
  const { cookie } = await signIn(person);
  expect((await post("/sign-out", cookie)).status).toBe(200);
  expect(await me(chrome.token)).toBe(401);
  expect(await sessionsOf(person)).toEqual([]);
  expect(
    audits.filter((event) => event.eventType === "recorder.sign_out_failed"),
  ).toEqual([]);
});

test("signing out everywhere, ending the other sessions, or ending one session ends the Recorders too", async () => {
  for (const [path, body] of [
    ["/revoke-sessions", {}],
    ["/revoke-other-sessions", {}],
  ] as const) {
    const chrome = await connect(person, "3".repeat(32));
    const here = await signIn(person);
    await signIn(person);
    expect((await post(path, here.cookie, body)).status, path).toBe(200);
    expect(await me(chrome.token), path).toBe(401);
    expect(endings(chrome.connection.id), path).toEqual([
      [chrome.connection.id, "signed_out", path],
    ]);
  }
  const chrome = await connect(person, "4".repeat(32));
  const here = await signIn(person);
  const phone = await signIn(person);
  expect(
    (await post("/revoke-session", here.cookie, { token: phone.token })).status,
  ).toBe(200);
  expect(await me(chrome.token)).toBe(401);
});

test("Better Auth ending a person's sessions any other way ends their Recorders: the directory, a password reset, another account proving the address", async () => {
  // Each of those ends sessions through Better Auth's own `deleteUserSessions`, outside the routes above.
  const chrome = await connect(person, "5".repeat(32));
  await signIn(person);
  await (await auth.$context).internalAdapter.deleteUserSessions(person);
  expect(await sessionsOf(person)).toEqual([]);
  expect(await me(chrome.token)).toBe(401);
  expect(endings(chrome.connection.id)).toEqual([
    [chrome.connection.id, "signed_out", "sessions-ended"],
  ]);
});

test("ending every session when the Recorders cannot be ended ends none, and says so", async () => {
  recorder = recorderWith(refusing());
  const chrome = await connect(person, "6".repeat(32));
  const here = await signIn(person);
  const elsewhere = await signIn(person);
  const refused = await post("/revoke-sessions", here.cookie);
  expect(refused.status).toBeGreaterThanOrEqual(500);
  expect((await sessionsOf(person)).sort()).toEqual(
    [here.token, elsewhere.token].sort(),
  );
  expect(await me(chrome.token)).toBe(200);
  expect(
    audits.find((event) => event.eventType === "recorder.sign_out_failed")
      ?.payload,
  ).toMatchObject({ ending: "/revoke-sessions", attempts: 3 });
});

test("a session that ends by itself, or is found expired, does not sign the Recorder out", async () => {
  const chrome = await connect(person, "f".repeat(32));
  // Better Auth deletes an expired session when it is next presented: that is not the person leaving.
  const { cookie } = await signIn(person, new Date(Date.now() - 60_000));
  const asked = await app.request(`${BASE}/api/auth/get-session`, {
    headers: { cookie },
  });
  expect(asked.status).toBe(200);
  expect(await sessionsOf(person)).toEqual([]);
  expect(await me(chrome.token)).toBe(200);
});

test("a Recorder connection lasts as long as an OpenBot session: Better Auth's own lifetime, read from the auth", async () => {
  expect(await sessionLifetimeMs(auth)).toBe(SESSION_LIFETIME_MS);
});
