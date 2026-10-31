import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ExchangeResponse } from "@openbot/shared/recorder-api";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import { DEV_ACTOR, initializeDevActorUser } from "../src/auth/dev-actor";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { recorderConnections } from "../src/db/schema/recorder";
import { personalLearningContainerId } from "../src/learning/personal-space";
import { RECORDER_BEARER } from "../src/recorder/guard";
import { createRecorderExtension } from "../src/recorder/wiring";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const other = `recorder-single-${randomUUID()}-other`;
const ORIGIN = `chrome-extension://${RECORDER_EXTENSION_ID}`;

const config = loadConfig({
  DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:5432/openbot",
  KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  INTELLIGENCE_API_URL: "http://127.0.0.1:7100",
  INTELLIGENCE_GATEWAY_WS_URL: "ws://127.0.0.1:7103",
  INTELLIGENCE_API_KEY: "tenant-api-key",
  COPILOTKIT_LICENSE_TOKEN: "license-token",
  OPENBOT_SINGLE_USER: "true",
});
const auditStore = { insert: async (_event: AuditEventInput) => {} };
const roleRepository = { rolesForUser: async () => ["admin" as const] };
const recorder = createRecorderExtension({
  config,
  database,
  organizationAuth: undefined,
  roleRepository,
  peopleStore: { isRevoked: async () => false },
  personalSpaces: {
    containerFor: personalLearningContainerId,
    state: async (userId) => ({
      state: "assigned",
      containerId: personalLearningContainerId(userId),
    }),
    kick: () => {},
  },
  auditStore,
});
/*
 * createApp is positional. Placed by index rather than after a spread of `undefined`s, whose length
 * TypeScript cannot see, so each dependency is type-checked against the parameter it lands on.
 */
const args = new Array(createApp.length) as unknown as Parameters<
  typeof createApp
>;
args[0] = config;
args[2] = roleRepository;
args[12] = auditStore;
args[34] = { recorder };
const app = createApp(...args);

const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const { json, headers, ...rest } = init;
  return app.request(`http://openbot.test${path}`, {
    ...rest,
    headers: {
      ...(json === undefined ? {} : { "content-type": "application/json" }),
      ...(headers as Record<string, string>),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
};

beforeAll(async () => {
  expect(config.singleUser).toBe(true);
  await initializeDevActorUser(database, true);
  await database
    .insert(users)
    .values({ id: other, email: `${other}@example.test`, name: "Other" });
});
afterAll(async () => {
  await database
    .delete(recorderConnections)
    .where(eq(recorderConnections.userId, DEV_ACTOR.id));
  await database.delete(users).where(inArray(users.id, [other]));
  await database.$client.close();
});

test("in single-user mode a connect code, an exchange and the bearer all resolve to the one local person", async () => {
  const minted = await call("/api/recorder/connect-codes", {
    method: "POST",
    json: { via: "web" },
  });
  expect(minted.status).toBe(201);
  const { code } = (await minted.json()) as { code: string };
  const exchanged = await call("/api/recorder/connections", {
    method: "POST",
    headers: { origin: ORIGIN },
    json: { code, label: "Chrome on macOS", installId: "f".repeat(32) },
  });
  expect(exchanged.status).toBe(201);
  const { token } = (await exchanged.json()) as ExchangeResponse;
  const headers = { authorization: `Bearer ${token}` };
  const me = await call("/api/recorder/me", { headers });
  expect(me.status).toBe(200);
  expect(((await me.json()) as { user: { id: string } }).user.id).toBe(
    "dev-local-user",
  );
  // The one local person's recordings go into their own Learning space.
  const learning = await call("/api/recorder/learning", { headers });
  expect(learning.status).toBe(200);
  expect(await learning.json()).toEqual({
    learning: {
      state: "assigned",
      containerId: personalLearningContainerId("dev-local-user"),
    },
  });
});

/** A live connection stored the way the connection store stores one: a well-formed token and its SHA-256. */
async function seedConnection(userId: string, installId: string) {
  const token = `obr_${randomBytes(32).toString("base64url")}`;
  // Well-formed, so the resolver reads the row instead of refusing the shape of the token.
  expect(RECORDER_BEARER.test(`Bearer ${token}`)).toBe(true);
  await database.insert(recorderConnections).values({
    id: randomUUID(),
    userId,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    label: "Seeded",
    via: "web",
    extensionId: RECORDER_EXTENSION_ID,
    installId,
  });
  return token;
}

test("a connection that belongs to another person is refused", async () => {
  // The control: a row built the same way for the one local person is accepted, so a refusal below
  // can only come from whose row it is.
  const mine = await seedConnection(DEV_ACTOR.id, "8".repeat(32));
  const accepted = await call("/api/recorder/me", {
    headers: { authorization: `Bearer ${mine}` },
  });
  expect(accepted.status).toBe(200);

  const theirs = await seedConnection(other, "9".repeat(32));
  const refused = await call("/api/recorder/me", {
    headers: { authorization: `Bearer ${theirs}` },
  });
  expect(refused.status).toBe(401);
});
