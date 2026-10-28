import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import { createAuth, sessionLifetimeMs } from "../src/auth";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { sessions, users } from "../src/db/schema/core";
import { createRecorderExtension } from "../src/recorder/wiring";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { SESSION_LIFETIME_MS, testEnvironment } from "./support/environment";

/*
 * Signing out of OpenBot signs the person's Recorders out with them, through the real Better Auth sign-out and the
 * Recorder's own guard: what index.ts wires, built here the same way (index.ts cannot be imported by a test).
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

// As index.ts: the sign-out reaches the Recorder's wiring, which is built after the auth it is handed to.
let recorder: ReturnType<typeof createRecorderExtension>;
const auth = createAuth(config, database, undefined, undefined, {
  onSignedOut: async (userId) => {
    await recorder.connections.revokeAll(userId, "signed_out");
  },
});

let app: ReturnType<typeof createApp>;
let cookieName: string;

beforeAll(async () => {
  await database.insert(users).values([
    { id: person, email: `${person}@example.test`, name: "Leaving" },
    { id: other, email: `${other}@example.test`, name: "Staying" },
  ]);
  recorder = createRecorderExtension({
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
    sessionLifetimeMs: await sessionLifetimeMs(auth),
  });
  const args = new Array(createApp.length) as unknown as Parameters<
    typeof createApp
  >;
  args[0] = config;
  args[1] = auth as never;
  args[2] = roleRepository;
  args[12] = auditStore;
  args[34] = { recorder };
  app = createApp(...args);
  cookieName = (await auth.$context).authCookies.sessionToken.name;
});
afterAll(async () => {
  await database.delete(users).where(eq(users.id, person));
  await database.delete(users).where(eq(users.id, other));
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
  return `${cookieName}=${encodeURIComponent(`${token}.${signature}`)}`;
}

/** A browser connected as this person, the way the Recorder connects one. */
async function connect(userId: string, installId: string) {
  const minted = await recorder.connections.mintCode(userId, "web");
  const made = await recorder.connections.exchange({
    code: minted!.code,
    label: "Chrome on macOS",
    extensionId: RECORDER_EXTENSION_ID,
    installId,
  });
  return made!;
}

const me = (token: string) =>
  app.request(`${BASE}/api/recorder/me`, {
    headers: { authorization: `Bearer ${token}` },
  });

test("signing out of OpenBot signs every Recorder connected as that person out, and nobody else's", async () => {
  const chrome = await connect(person, "c".repeat(32));
  const edge = await connect(person, "e".repeat(32));
  const theirs = await connect(other, "c".repeat(32));
  const cookie = await signIn(person);
  expect((await me(chrome.token)).status).toBe(200);

  const signedOut = await app.request(`${BASE}/api/auth/sign-out`, {
    method: "POST",
    headers: { cookie, origin: BASE, "content-type": "application/json" },
    body: "{}",
  });
  expect(signedOut.status).toBe(200);

  for (const token of [chrome.token, edge.token]) {
    expect((await me(token)).status).toBe(401);
  }
  expect((await me(theirs.token)).status).toBe(200);
  expect(
    audits
      .filter(
        (event) =>
          event.eventType === "recorder.revoked" &&
          event.payload.reason === "signed_out",
      )
      .map((event) => event.targetId)
      .sort(),
  ).toEqual([chrome.connection.id, edge.connection.id].sort());
});

test("a session that ends by itself, or is found expired, does not sign the Recorder out", async () => {
  const chrome = await connect(person, "f".repeat(32));
  // Better Auth deletes an expired session when it is next presented: that is not the person leaving.
  const cookie = await signIn(person, new Date(Date.now() - 60_000));
  const asked = await app.request(`${BASE}/api/auth/get-session`, {
    headers: { cookie },
  });
  expect(asked.status).toBe(200);
  expect(
    await database
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, person)),
  ).toEqual([]);
  expect((await me(chrome.token)).status).toBe(200);
});

test("a Recorder connection lasts as long as an OpenBot session: Better Auth's own lifetime, read from the auth", async () => {
  expect(await sessionLifetimeMs(auth)).toBe(SESSION_LIFETIME_MS);
});
