/**
 * An existing deployment's people, removed addresses, linked accounts and identity providers move into
 * Intelligence's organization directory at boot, once.
 *
 * The database is seeded the way the previous release left it (people with no directory version, roles
 * in `user_roles`), the migration's own backfill runs over it, and the copy runs as the server runs it.
 * Against a real Intelligence, in a project of its own (`TEST_INTELLIGENCE_API_KEY_2`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { registerScimConnection } from "../src/auth/scim";
import { createDatabase } from "../src/db/client";
import {
  directoryRemovalReactions,
  identityLinks,
  intelligenceCopies,
  revokedAccess,
  scimGroupMembers,
  scimGroups,
  scimUsers,
  ssoProviders,
  userRoles,
  users,
} from "../src/db/schema";
import {
  createDirectoryClient,
  idempotencyKey,
} from "../src/people/directory/client";
import { createPeopleDirectory } from "../src/people/directory/directory";
import {
  copyLocalPeopleToIntelligence,
  PEOPLE_COPY_NAME,
} from "../src/people/directory/upgrade";
import { secondTestProject, testIntelligence } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { uniqueEmail } from "./support/directory";

/** A project of its own: the upgrade copy writes a whole deployment's people into its project. */
function secondProjectKey(): string {
  return secondTestProject().apiKey;
}

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const client = createDirectoryClient({
  apiUrl: testIntelligence().apiUrl,
  apiKey: secondProjectKey(),
});
const directory = createPeopleDirectory({ client, database });

const run = randomUUID().slice(0, 8);
const admin = {
  id: `upgrade-admin-${run}`,
  email: uniqueEmail("upgrade-admin"),
};
const member = {
  id: `upgrade-member-${run}`,
  email: uniqueEmail("upgrade-member"),
};
const removedPerson = {
  id: `upgrade-removed-${run}`,
  email: uniqueEmail("upgrade-removed"),
};
const goneEmail = uniqueEmail("upgrade-gone");
const providerId = `upgrade-okta-${run}`;
const scimUserId = `legacy-scim-user-${run}`;
const scimGroupId = `legacy-scim-group-${run}`;
const ids = [admin.id, member.id, removedPerson.id];

async function resetProject() {
  for (const person of (await client.allPeople({ includeDeleted: true }))
    .people)
    await client.purgePerson(person.id, idempotencyKey("test-reset"));
  for (const removal of await client.allRemovals())
    await client.deleteRemoval(removal.email, idempotencyKey("test-reset"));
  for (const provider of await client.allIdentityProviders())
    await client.deleteIdentityProvider(
      provider.providerId,
      idempotencyKey("test-reset"),
    );
}

/** The previous release's rows: no directory version, roles in `user_roles`. */
async function seedPreviousRelease() {
  await database.insert(users).values([
    {
      id: admin.id,
      email: admin.email,
      name: "Upgraded Admin",
      emailVerified: true,
      preferences: { skin: "openbot" },
      onboardingStep: 2,
      onboardingCompletedAt: new Date("2026-10-01T10:00:00Z"),
      lastSignedInAt: new Date("2026-11-01T09:00:00Z"),
      createdAt: new Date("2026-09-01T08:00:00Z"),
    },
    { id: member.id, email: member.email, name: "Upgraded Member" },
    { id: removedPerson.id, email: removedPerson.email, name: "Removed" },
  ]);
  await database.insert(userRoles).values([
    { userId: admin.id, role: "admin" },
    { userId: admin.id, role: "user" },
    { userId: member.id, role: "user" },
    { userId: removedPerson.id, role: "user" },
  ]);
  await database.insert(revokedAccess).values([
    { email: removedPerson.email, revokedBy: admin.id },
    // Removed, and their row since deleted: the address alone is what keeps them out.
    { email: goneEmail, revokedBy: "scim:directory" },
  ]);
  await database.insert(identityLinks).values([
    {
      id: randomUUID(),
      provider: "slack",
      realm: `T${run}`,
      subject: `U-admin-${run}`,
      userId: admin.id,
      handle: "@admin",
      verifiedBy: "challenge",
      status: "active",
    },
    {
      id: randomUUID(),
      provider: "github",
      realm: "github.com",
      subject: `gh-removed-${run}`,
      userId: removedPerson.id,
      handle: null,
      verifiedBy: "oauth",
      status: "needs_reconnect",
    },
  ]);
  await database.insert(ssoProviders).values({
    id: randomUUID(),
    issuer: "https://acme.okta.example.test",
    oidcConfig: '{"version":1,"iv":"x","ciphertext":"secret-stays-here"}',
    providerId,
    domain: "Acme.example.test",
    userId: admin.id,
  });
  // The SCIM endpoint this deployment served itself: a provisioned user, a group with them in it.
  await database.insert(scimUsers).values({
    id: scimUserId,
    connectionId: "directory",
    provisioningDomainId: "directory",
    userId: admin.id,
    connectionUserKey: `directory:${scimUserId}`,
    userName: admin.email,
    userNameKey: `directory:${admin.email}`,
    primaryEmail: admin.email,
    workEmailValueIndex: admin.email,
    emailValueIndex: admin.email,
    displayName: "Upgraded Admin",
    formattedName: "Upgraded Admin",
    givenName: "Upgraded",
    familyName: "Admin",
    serializedEmails: JSON.stringify([
      { value: admin.email, type: "work", primary: true },
    ]),
    externalId: `okta-${run}`,
    externalIdKey: `directory:okta-${run}`,
    active: true,
    orderKey: `order-${scimUserId}`,
    createdAt: new Date("2026-09-02T08:00:00Z"),
    updatedAt: new Date("2026-09-02T08:00:00Z"),
  });
  await database.insert(scimGroups).values({
    id: scimGroupId,
    connectionId: "directory",
    provisioningDomainId: "directory",
    displayName: `Upgraded ${run}`,
    displayNameKey: `directory:upgraded-${run}`,
    orderKey: `order-${scimGroupId}`,
    createdAt: new Date("2026-09-03T08:00:00Z"),
    updatedAt: new Date("2026-09-03T08:00:00Z"),
  });
  await database.insert(scimGroupMembers).values({
    id: `member-${run}`,
    connectionId: "directory",
    groupId: scimGroupId,
    scimUserId,
    membershipKey: `directory:${scimGroupId}:${scimUserId}`,
    createdAt: new Date("2026-09-03T08:00:00Z"),
  });
  // The migration's own role backfill, as a deployment runs it.
  const migration = readFileSync(
    join(import.meta.dir, "..", "drizzle", "0077_data_in_intelligence.sql"),
    "utf8",
  );
  const start = migration.indexOf('UPDATE "users"');
  const backfill = migration.slice(
    start,
    migration.indexOf("--> statement-breakpoint", start),
  );
  await database.execute(sql.raw(backfill));
}

async function cleanLocal() {
  await database
    .delete(scimGroupMembers)
    .where(eq(scimGroupMembers.groupId, scimGroupId));
  await database.delete(scimGroups).where(eq(scimGroups.id, scimGroupId));
  await database.delete(scimUsers).where(eq(scimUsers.id, scimUserId));
  await database
    .delete(directoryRemovalReactions)
    .where(inArray(directoryRemovalReactions.email, [goneEmail]));
  await database
    .delete(identityLinks)
    .where(inArray(identityLinks.userId, ids));
  await database
    .delete(ssoProviders)
    .where(eq(ssoProviders.providerId, providerId));
  await database
    .delete(revokedAccess)
    .where(inArray(revokedAccess.email, [removedPerson.email, goneEmail]));
  await database.delete(users).where(inArray(users.id, ids));
  await database
    .delete(intelligenceCopies)
    .where(eq(intelligenceCopies.name, PEOPLE_COPY_NAME));
}

beforeAll(async () => {
  await resetProject();
  await cleanLocal();
  // Every other pending row in this database is somebody else's fixture; the copy would take them too.
  await database
    .update(users)
    .set({ directoryPending: false })
    .where(eq(users.directoryPending, true));
  await seedPreviousRelease();
});

afterAll(async () => {
  await resetProject();
  await cleanLocal();
  await database.$client.close();
});

describe("the boot-time copy", () => {
  test("carries every person with their role, settings and history, and records itself", async () => {
    const outcome = await copyLocalPeopleToIntelligence(database, directory);
    expect(outcome).toMatchObject({
      kind: "copied",
      people: 3,
      identities: 2,
      scimUsers: 1,
      scimGroups: 1,
    });

    const copiedAdmin = await client.getPerson(admin.id);
    expect(copiedAdmin).toMatchObject({
      email: admin.email,
      name: "Upgraded Admin",
      role: "admin",
      preferences: { skin: "openbot" },
      onboardingStep: 2,
    });
    expect(copiedAdmin?.createdAt.toISOString()).toBe(
      "2026-09-01T08:00:00.000Z",
    );
    expect(copiedAdmin?.onboardingCompletedAt?.toISOString()).toBe(
      "2026-10-01T10:00:00.000Z",
    );
    expect(copiedAdmin?.lastSignedInAt?.toISOString()).toBe(
      "2026-11-01T09:00:00.000Z",
    );
    expect((await client.getPerson(member.id))?.role).toBe("user");

    // Each row now says which version it reflects, and the role the guard reads is the copied one.
    const local = await database
      .select()
      .from(users)
      .where(inArray(users.id, ids));
    for (const row of local) {
      expect(row.directoryVersion).not.toBeNull();
      expect(row.directoryPending).toBe(false);
    }
    expect(local.find((row) => row.id === admin.id)?.role).toBe("admin");

    expect((await client.getRemoval(removedPerson.email))?.removedBy).toBe(
      admin.id,
    );
    expect((await client.getRemoval(goneEmail))?.removedBy).toBe(
      "scim:directory",
    );

    const links = await client.listIdentities({});
    expect(
      links.find((link) => link.subject === `U-admin-${run}`),
    ).toMatchObject({ userId: admin.id, handle: "@admin", status: "active" });
    expect(
      links.find((link) => link.subject === `gh-removed-${run}`),
    ).toMatchObject({ userId: removedPerson.id, status: "needs_reconnect" });

    const providers = await client.allIdentityProviders();
    expect(
      providers.find((provider) => provider.providerId === providerId),
    ).toMatchObject({
      issuer: "https://acme.okta.example.test",
      domain: "acme.example.test",
      protocol: "oidc",
      registeredBy: admin.id,
    });

    const [record] = await database
      .select()
      .from(intelligenceCopies)
      .where(eq(intelligenceCopies.name, PEOPLE_COPY_NAME));
    expect(record?.copied).toBe(3);
  });

  test("hands the SCIM users and groups it served to Intelligence under their ids", async () => {
    // The company's directory goes on with the ids it holds, now answered by Intelligence.
    const token = `scim-${randomUUID()}`;
    await registerScimConnection(client, {
      SCIM_BEARER_TOKEN: token,
      SCIM_CONNECTION_ID: "directory",
    });
    const base = `${testIntelligence().apiUrl}/api/directory/scim/v2`;
    const read = await fetch(`${base}/Users/${scimUserId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      id: scimUserId,
      userName: admin.email,
      externalId: `okta-${run}`,
      active: true,
    });
    const group = await fetch(`${base}/Groups/${scimGroupId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await group.json()).toMatchObject({
      displayName: `Upgraded ${run}`,
      members: [{ value: scimUserId }],
    });
    expect((await client.getPerson(admin.id))?.groups).toEqual([
      `Upgraded ${run}`,
    ]);
    // A deprovision SCIM made under the previous release counts as acted on: not acted on again.
    const [acted] = await database
      .select()
      .from(directoryRemovalReactions)
      .where(eq(directoryRemovalReactions.email, goneEmail));
    expect(acted).toBeDefined();
  });

  test("never runs twice", async () => {
    expect(await copyLocalPeopleToIntelligence(database, directory)).toEqual({
      kind: "done-before",
    });
  });

  test("two replicas copying at once make one copy", async () => {
    // Start over, as two replicas booting the same upgraded database together would.
    await resetProject();
    await database
      .update(users)
      .set({ directoryVersion: null, directoryPending: true })
      .where(inArray(users.id, ids));
    await database
      .delete(intelligenceCopies)
      .where(eq(intelligenceCopies.name, PEOPLE_COPY_NAME));

    const outcomes = await Promise.all([
      copyLocalPeopleToIntelligence(
        database,
        createPeopleDirectory({ client, database }),
      ),
      copyLocalPeopleToIntelligence(
        database,
        createPeopleDirectory({ client, database }),
      ),
    ]);
    for (const outcome of outcomes) expect(outcome.kind).toBe("copied");

    const people = (await client.allPeople({ includeDeleted: true })).people;
    expect(people.map((person) => person.id).sort()).toEqual([...ids].sort());
    expect(
      (await client.listIdentities({})).filter((link) =>
        link.subject.endsWith(run),
      ),
    ).toHaveLength(2);
  });
});
