import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import {
  type EnterpriseControls,
  installEnterpriseControls,
} from "../src/admin/controls";
import { createEnterpriseAdminRoutes } from "../src/admin/routes";
import { createApp } from "../src/app";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { enterpriseSettings } from "../src/db/schema/admin";
import {
  accounts,
  revokedAccess,
  sessions,
  ssoProviders,
  users,
} from "../src/db/schema/core";
import { recorderConnections } from "../src/db/schema/recorder";
import { retireOwnedAccounts } from "../src/identity/retire";
import { createPeopleStore } from "../src/people/store";
import { createRecorderExtension } from "../src/recorder/wiring";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { SESSION_LIFETIME_MS, testEnvironment } from "./support/environment";

/*
 * The two ways OpenBot itself ends people's sessions, outside Better Auth's own routes, end their Recorders too:
 * an administrator removing somebody (People), and SSO-required being turned on (Admin, Enterprise). Each through its
 * real route, on the real database, with the Recorder wired as index.ts wires it.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const admin = {
  id: `ended-admin-${suite}`,
  email: `ended-admin-${suite}@example.test`,
};
const leaving = {
  id: `ended-leaving-${suite}`,
  email: `ended-leaving-${suite}@example.test`,
};
const viaSso = {
  id: `ended-sso-${suite}`,
  email: `ended-sso-${suite}@example.test`,
};
const providerId = `ended-idp-${suite}`;

const config = loadConfig(testEnvironment());
const audits: AuditEventInput[] = [];
const auditStore = {
  insert: async (event: AuditEventInput) => {
    audits.push(event);
  },
};
const roleRepository = {
  rolesForUser: async (id: string) =>
    id === admin.id ? ["admin" as const] : ["user" as const],
};

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
const working = recorderWith();
/** The trail refusing every row a connection's change writes: the Recorders cannot be ended. */
const broken = recorderWith(() => ({
  insert: async () => {
    throw new Error("the audit trail is unavailable");
  },
}));
let recorder = working;

/*
 * The people store as index.ts builds it, with what a removal retires: no connectors here, and the person's
 * Recorders, through the same `retireOwnedAccounts` and the same sign-out index.ts passes it.
 */
const peopleStore = createPeopleStore(database, [], (userId) =>
  retireOwnedAccounts({
    plugins: async () => ({ retired: 0 }),
    identities: async () => 0,
    recorders: () => recorder.signOut(userId, "person_removed"),
  }),
);

/** OpenBot's own app, signed in as the administrator by a test cookie. */
function appAsAdmin() {
  const args = new Array(createApp.length) as unknown as Parameters<
    typeof createApp
  >;
  args[0] = config;
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async ({ headers }: { headers: Headers }) =>
        headers.get("cookie")?.includes("test-session=admin")
          ? { user: { ...admin, name: "Admin" } }
          : null,
    },
  } as never;
  args[2] = roleRepository;
  args[12] = auditStore;
  args[17] = peopleStore;
  args[34] = { recorder: working };
  return createApp(...args);
}
const app = appAsAdmin();

/** The enterprise routes, as app.ts mounts them, with the administrator signed in. */
const enterprise = new Hono<{ Variables: AppVariables }>();
enterprise.route(
  "/api/admin/enterprise",
  createEnterpriseAdminRoutes(async (context, next) => {
    context.set("actor", {
      ...admin,
      name: "Admin",
      image: null,
      role: "admin",
    });
    await next();
  }),
);
let controls: EnterpriseControls;

beforeAll(async () => {
  await database.insert(users).values([admin, leaving, viaSso]);
  await database.insert(ssoProviders).values({
    id: providerId,
    issuer: "https://idp.example.test",
    providerId,
    domain: "example.test",
  });
  await database.insert(accounts).values({
    id: randomUUID(),
    accountId: `subject-${suite}`,
    providerId,
    userId: viaSso.id,
  });
  controls = await installEnterpriseControls({
    database,
    databaseUrl: testDatabaseUrl(),
    auditStore,
    env: {},
    initialAdminEmails: [],
    // As index.ts passes it.
    recorders: {
      holders: () => working.connections.holders(),
      signOut: (userId, ending) => recorder.signOut(userId, ending),
    },
  });
});
beforeEach(() => {
  recorder = working;
  audits.length = 0;
});
afterAll(async () => {
  await controls?.stop();
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, "sso_required"));
  await database
    .delete(revokedAccess)
    .where(eq(revokedAccess.email, leaving.email));
  await database.delete(ssoProviders).where(eq(ssoProviders.id, providerId));
  await database
    .delete(users)
    .where(inArray(users.id, [admin.id, leaving.id, viaSso.id]));
  await database.$client.close();
});

async function connect(userId: string, installId: string) {
  const minted = await working.connections.mintCode(userId, "web");
  return (await working.connections.exchange({
    code: minted!.code,
    label: "Chrome on macOS",
    extensionId: RECORDER_EXTENSION_ID,
    installId,
  }))!;
}
const me = async (token: string) =>
  (
    await app.request("http://openbot.test/api/recorder/me", {
      headers: { authorization: `Bearer ${token}` },
    })
  ).status;
const signedInSession = (userId: string) => ({
  id: randomUUID(),
  userId,
  token: randomUUID(),
  expiresAt: new Date(Date.now() + 3_600_000),
});

test("removing somebody ends their browsers' Recorders with their sessions, and a removal that could not end them is finished by removing them again", async () => {
  const chrome = await connect(leaving.id, "a".repeat(32));
  const remove = () =>
    app.request(`http://openbot.test/api/admin/people/${leaving.id}/access`, {
      method: "POST",
      headers: {
        cookie: "test-session=admin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ revoked: true }),
    });

  recorder = broken;
  const failed = await remove();
  expect(failed.status).toBe(500);
  expect(
    audits.find((event) => event.eventType === "recorder.sign_out_failed")
      ?.payload,
  ).toMatchObject({ ending: "person_removed", attempts: 3 });
  const [still] = await database
    .select({ revokedAt: recorderConnections.revokedAt })
    .from(recorderConnections)
    .where(eq(recorderConnections.id, chrome.connection.id));
  expect(still?.revokedAt).toBeNull();

  recorder = working;
  expect((await remove()).status).toBe(200);
  const [ended] = await database
    .select({ revokedAt: recorderConnections.revokedAt })
    .from(recorderConnections)
    .where(eq(recorderConnections.id, chrome.connection.id));
  expect(ended?.revokedAt).not.toBeNull();
  expect(
    audits.find(
      (event) =>
        event.eventType === "recorder.revoked" &&
        event.targetId === chrome.connection.id,
    )?.payload,
  ).toEqual({
    connectionId: chrome.connection.id,
    via: "web",
    reason: "signed_out",
    ending: "person_removed",
  });
});

test("turning SSO-required on ends the Recorders of the people it signs out, before their sessions, and keeps those it keeps", async () => {
  await database
    .delete(revokedAccess)
    .where(eq(revokedAccess.email, leaving.email));
  const theirs = await connect(leaving.id, "b".repeat(32));
  const sso = await connect(viaSso.id, "b".repeat(32));
  const mine = await connect(admin.id, "b".repeat(32));
  const google = signedInSession(leaving.id);
  await database.insert(sessions).values(google);
  const requireSso = () =>
    enterprise.request("/api/admin/enterprise/settings/ssoRequired", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: true }),
    });

  // When their Recorders cannot be ended, the save says so, and no session has ended yet.
  recorder = broken;
  const failed = await requireSso();
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({
    error:
      "SSO is now required, but not everybody could be signed out yet. Save it again to finish.",
  });
  expect(
    await database
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, google.id)),
  ).toHaveLength(1);
  expect(await me(theirs.token)).toBe(200);

  // Saving again finishes it.
  recorder = working;
  expect((await requireSso()).status).toBe(200);
  expect(await me(theirs.token)).toBe(401);
  expect(
    await database
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, google.id)),
  ).toEqual([]);
  // Signed in through SSO, and the administrator saving it: both still recording.
  expect(await me(sso.token)).toBe(200);
  expect(await me(mine.token)).toBe(200);
  expect(
    audits.find(
      (event) =>
        event.eventType === "recorder.revoked" &&
        event.targetId === theirs.connection.id,
    )?.payload,
  ).toMatchObject({ reason: "signed_out", ending: "sso_required" });
});
