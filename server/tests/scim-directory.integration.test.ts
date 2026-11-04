/**
 * SCIM 2.0, served by Intelligence's organization directory, reached at the address a company's
 * directory was always given here (`/api/auth/scim/v2`), with the token it was always given.
 *
 * The requests are the ones Okta and Microsoft Entra send, in their order, through the forwarder the
 * app mounts, against a real Intelligence and a real database. What only this deployment can do
 * happens through the real Better Auth (a deactivated person's sessions end through its own adapter,
 * so its hooks run) and the real trail. The old Better Auth SCIM tables get no writes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createAuth } from "../src/auth";
import { createScimForwarder, registerScimConnection } from "../src/auth/scim";
import type { DeploymentConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { scimGroups, scimUsers, sessions, users } from "../src/db/schema";
import { createScimReactions } from "../src/people/directory/scim-reactions";
import { auditRows, useTestAuditTrail } from "./support/audit";
import { testIntelligence } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  liftRemovals,
  purgeDirectoryPeople,
  uniqueEmail,
  useTestPeople,
} from "./support/directory";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
// The trail is Intelligence's: the reactions write it through the outbox, read back from there.
useTestAuditTrail();
const directory = useTestPeople();
const auditStore = createAuditStore(database);
const token = `scim-${randomUUID()}`;
const connectionId = `test-${randomUUID().slice(0, 8)}`;
const OWN = "http://127.0.0.1:3000/api/auth/scim/v2";
const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const made: string[] = [];
const emails: string[] = [];

const auth = createAuth(
  {
    auth: {
      baseUrl: "http://127.0.0.1:3000",
      secret: "x".repeat(40),
      trustedOrigins: [],
      initialAdminEmails: [],
      allowedEmailDomains: [],
      google: { clientId: "id", clientSecret: "secret" },
    },
    keyEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  } as unknown as DeploymentConfig,
  database,
  async () => false,
  auditStore,
);
const offboarded: string[] = [];
const reactions = createScimReactions({
  database,
  client: directory.client,
  initialAdminEmails: [],
  endSessions: async (userId) => {
    await (await auth.$context).internalAdapter.deleteUserSessions(userId);
  },
  offboard: async (userId) => {
    offboarded.push(userId);
  },
  auditStore,
});
const forward = createScimForwarder({
  intelligenceApiUrl: testIntelligence().apiUrl,
  publicBaseUrl: OWN,
  afterWrite: () => reactions.reconcile(),
});

/** A request as the company's directory sends it, to this deployment's own address. */
const scim = async (
  method: string,
  path: string,
  body?: unknown,
  bearer = token,
) => {
  const response = await forward(
    new Request(`${OWN}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/scim+json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
};

const personWith = async (email: string) =>
  (await directory.client.pagePeople({ email, includeDeleted: true }))
    .people[0];

/** How many of this event the trail in Intelligence holds for the person (written through the outbox). */
const auditFor = async (targetId: string, eventType: string) =>
  (await auditRows({ targetId, eventType })).length;

let legacyCounts: { users: number; groups: number };

beforeAll(async () => {
  // At boot, as the server does: the connection accepts this deployment's token, by its hash.
  expect(
    await registerScimConnection(directory.client, {
      SCIM_BEARER_TOKEN: token,
      SCIM_CONNECTION_ID: connectionId,
    }),
  ).toBe(true);
  legacyCounts = await counts();
});

afterAll(async () => {
  await liftRemovals(emails);
  const ids: string[] = [...made];
  for (const email of emails) {
    const person = await personWith(email);
    if (person) ids.push(person.id);
  }
  await purgeDirectoryPeople(ids);
  await database.$client.end({ timeout: 5 });
});

async function counts() {
  const [u] = await database.select({ n: count() }).from(scimUsers);
  const [g] = await database.select({ n: count() }).from(scimGroups);
  return { users: u?.n ?? 0, groups: g?.n ?? 0 };
}

describe("SCIM at this deployment's address, served by Intelligence's directory", () => {
  test("a wrong token is refused", async () => {
    const refused = await scim("GET", "/Users", undefined, "wrong");
    expect(refused.status).toBe(401);
    expect(refused.body).toMatchObject({ status: "401" });
  });

  test("Okta: provision, group, deactivate (sessions end here), reactivate", async () => {
    const email = uniqueEmail("okta");
    emails.push(email);
    const created = await scim("POST", "/Users", {
      schemas: [USER],
      userName: email,
      name: { givenName: "Scim", familyName: "Person" },
      emails: [{ primary: true, value: email, type: "work" }],
      displayName: "Scim Person",
      externalId: `ext-${randomUUID().slice(0, 8)}`,
      active: true,
    });
    expect(created.status).toBe(201);
    // The addresses the directory sees are this deployment's, as they always were.
    expect(created.headers.get("location")).toStartWith(`${OWN}/Users/`);
    const meta = created.body?.meta as { location?: string } | undefined;
    expect(meta?.location).toStartWith(`${OWN}/Users/`);
    const person = await personWith(email);
    expect(person).toMatchObject({
      role: "user",
      provisionedBy: `scim:${connectionId}`,
    });
    if (!person) throw new Error("not provisioned");

    // The announcement brings the person here; the replica that inserted them writes the trail.
    await directory.refresh(person.id);
    await reactions.arrived(person);
    expect(await auditFor(person.id, "person.provisioned")).toBe(1);

    const group = await scim("POST", "/Groups", {
      schemas: [GROUP],
      displayName: `engineering-${connectionId}`,
      members: [{ value: created.body?.id }],
    });
    expect(group.status).toBe(201);
    expect((await personWith(email))?.groups).toEqual([
      `engineering-${connectionId}`,
    ]);
    await directory.refresh(person.id);
    const [grouped] = await database
      .select({ groups: users.groups })
      .from(users)
      .where(eq(users.id, person.id));
    expect(grouped?.groups).toEqual([`engineering-${connectionId}`]);

    // Signed in, then deactivated by the directory.
    await database.insert(sessions).values({
      id: `scim-session-${randomUUID()}`,
      userId: person.id,
      token: `scim-token-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const deactivated = await scim("PATCH", `/Users/${created.body?.id}`, {
      schemas: [PATCH_OP],
      Operations: [{ op: "replace", value: { active: false } }],
    });
    expect(deactivated.status).toBe(200);
    // Deny-listed in Intelligence, and here, before the directory was answered: no session left,
    // what they connected retired, the trail written, once.
    expect((await directory.client.getRemoval(email))?.removedBy).toBe(
      `scim:${connectionId}`,
    );
    const [left] = await database
      .select({ n: count() })
      .from(sessions)
      .where(eq(sessions.userId, person.id));
    expect(left?.n).toBe(0);
    expect(offboarded).toContain(person.id);
    expect(await auditFor(person.id, "person.deprovisioned")).toBe(1);
    await reactions.reconcile();
    expect(await auditFor(person.id, "person.deprovisioned")).toBe(1);

    const reactivated = await scim("PATCH", `/Users/${created.body?.id}`, {
      schemas: [PATCH_OP],
      Operations: [{ op: "replace", path: "active", value: true }],
    });
    expect(reactivated.status).toBe(200);
    expect(await directory.client.getRemoval(email)).toBeNull();
    expect(await auditFor(person.id, "person.reprovisioned")).toBe(1);
  });

  test("Entra: capitalized ops, string booleans, filtered member removal", async () => {
    const email = uniqueEmail("entra");
    emails.push(email);
    const created = await scim("POST", "/Users", {
      schemas: [USER],
      externalId: `entra-${randomUUID().slice(0, 8)}`,
      userName: email,
      active: true,
      displayName: "Entra Person",
      emails: [{ primary: true, type: "work", value: email }],
    });
    expect(created.status).toBe(201);
    const found = await scim(
      "GET",
      `/Users?filter=${encodeURIComponent(`userName eq "${email}"`)}`,
    );
    expect(found.body).toMatchObject({ totalResults: 1 });
    const group = await scim("POST", "/Groups", {
      schemas: [GROUP],
      displayName: `entra-group-${connectionId}`,
      members: [{ value: created.body?.id }],
    });
    const removed = await scim("PATCH", `/Groups/${group.body?.id}`, {
      schemas: [PATCH_OP],
      Operations: [
        { op: "Remove", path: `members[value eq "${created.body?.id}"]` },
      ],
    });
    expect(removed.status).toBe(200);
    expect((await personWith(email))?.groups).toEqual([]);
    const disabled = await scim("PATCH", `/Users/${created.body?.id}`, {
      schemas: [PATCH_OP],
      Operations: [{ op: "Replace", path: "active", value: "False" }],
    });
    expect(disabled.status).toBe(200);
    expect((await directory.client.getRemoval(email))?.removedBy).toBe(
      `scim:${connectionId}`,
    );
  });

  test("the old Better Auth SCIM tables were not written", async () => {
    expect(await counts()).toEqual(legacyCounts);
  });
});
