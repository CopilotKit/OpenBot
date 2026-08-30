import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  externalUserLinks,
  revokedAccess,
  userRoles,
  users,
} from "../src/db/schema";
import { createExternalLinkStore } from "../src/external/link-store";
import { TEST_POOL } from "./support/database";

function testDatabaseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot"
  );
}

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createExternalLinkStore(database);
const suite = randomUUID().slice(0, 8);
const createdUsers: string[] = [];
const createdRevocations: string[] = [];
const LINK_CONFLICT_MESSAGE = "That Slack identity is already linked.";

function userId(label: string): string {
  const id = `external_link_${label}_${suite}`;
  createdUsers.push(id);
  return id;
}

function email(label: string): string {
  return `${label}_${suite}@example.test`;
}

async function createUser(input: {
  id: string;
  email: string;
  name: string;
  emailVerified?: boolean;
}) {
  await database.insert(users).values({
    ...input,
    emailVerified: input.emailVerified ?? true,
  });
}

function expectLinkConflict(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  if (error instanceof Error) {
    expect(error.message).toBe(LINK_CONFLICT_MESSAGE);
  }
}

afterAll(async () => {
  if (createdRevocations.length) {
    await database
      .delete(revokedAccess)
      .where(inArray(revokedAccess.email, createdRevocations));
  }
  if (createdUsers.length) {
    await database.delete(users).where(inArray(users.id, createdUsers));
  }
  await database.$client.end();
});

describe("external user links", () => {
  test("links one Slack identity to one OpenBot user and reads its provider email", async () => {
    const openbotUserId = userId("linked");
    const teamId = `T${suite}`;
    await createUser({
      id: openbotUserId,
      email: email("linked"),
      name: "Linked person",
    });

    await store.link({
      provider: "slack",
      providerTenantId: teamId,
      providerUserId: "U123",
      openbotUserId,
      providerEmail: "person@example.com",
    });

    expect(await store.find("slack", teamId, "U123")).toMatchObject({
      provider: "slack",
      providerTenantId: teamId,
      providerUserId: "U123",
      openbotUserId,
      providerEmail: "person@example.com",
    });
  });

  test("idempotently links the same provider identity to the same OpenBot user", async () => {
    const openbotUserId = userId("idempotent");
    const teamId = `T${suite}`;
    await createUser({
      id: openbotUserId,
      email: email("idempotent"),
      name: "Idempotent person",
    });

    const input = {
      provider: "slack" as const,
      providerTenantId: teamId,
      providerUserId: "U456",
      openbotUserId,
      providerEmail: "person@example.com",
    };
    const linked = await store.link(input);
    const repeated = await store.link(input);

    expect(repeated).toEqual(linked);
  });

  test("reports whether this call created an external link without changing link compatibility", async () => {
    const openbotUserId = userId("creation_status");
    const teamId = `T${suite}`;
    await createUser({
      id: openbotUserId,
      email: email("creation_status"),
      name: "Creation status person",
    });
    const input = {
      provider: "slack" as const,
      providerTenantId: teamId,
      providerUserId: "U457",
      openbotUserId,
      providerEmail: "person@example.com",
    };

    const first = await store.linkWithStatus(input);
    const repeated = await store.linkWithStatus(input);

    expect(first).toMatchObject({ created: true, link: input });
    expect(repeated).toEqual({ link: first.link, created: false });
    await expect(store.link(input)).resolves.toEqual(first.link);
  });

  test("reports exactly one creator when identical confirmations race", async () => {
    const openbotUserId = userId("creation_status_race");
    const teamId = `T${suite}`;
    await createUser({
      id: openbotUserId,
      email: email("creation_status_race"),
      name: "Creation status race person",
    });
    const input = {
      provider: "slack" as const,
      providerTenantId: teamId,
      providerUserId: "U458",
      openbotUserId,
      providerEmail: "person@example.com",
    };

    const results = await Promise.all([
      store.linkWithStatus(input),
      store.linkWithStatus(input),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.map((result) => result.link)).toEqual([
      results[0]?.link,
      results[0]?.link,
    ]);
  });

  test("rolls back a new link when its atomic audit write fails", async () => {
    const openbotUserId = userId("audit_rollback");
    const teamId = `T${suite}`;
    await createUser({
      id: openbotUserId,
      email: email("audit_rollback"),
      name: "Audit rollback person",
    });
    const input = {
      provider: "slack" as const,
      providerTenantId: teamId,
      providerUserId: "U459",
      openbotUserId,
      providerEmail: "person@example.com",
    };

    await expect(
      store.linkWithStatusAndAudit(input, async () => {
        throw new Error("audit table unavailable");
      }),
    ).rejects.toThrow("audit table unavailable");
    await expect(store.find("slack", teamId, "U459")).resolves.toBeNull();

    await expect(
      store.linkWithStatusAndAudit(input, async () => undefined),
    ).resolves.toMatchObject({ created: true, link: input });
  });

  test("never silently reassigns an existing provider identity to another user", async () => {
    const firstUserId = userId("first");
    const secondUserId = userId("second");
    const teamId = `T${suite}`;
    await createUser({
      id: firstUserId,
      email: email("first"),
      name: "First person",
    });
    await createUser({
      id: secondUserId,
      email: email("second"),
      name: "Second person",
    });
    await store.link({
      provider: "slack",
      providerTenantId: teamId,
      providerUserId: "U789",
      openbotUserId: firstUserId,
      providerEmail: "first@example.com",
    });

    const error = await store
      .link({
        provider: "slack",
        providerTenantId: teamId,
        providerUserId: "U789",
        openbotUserId: secondUserId,
        providerEmail: "second@example.com",
      })
      .catch((reason: unknown) => reason);
    expectLinkConflict(error);
    expect(await store.find("slack", teamId, "U789")).toMatchObject({
      openbotUserId: firstUserId,
      providerEmail: "first@example.com",
    });
  });

  test("rejects a second Slack identity claiming an OpenBot user in the same workspace", async () => {
    const openbotUserId = userId("one_identity");
    const teamId = `T${suite}`;
    await createUser({
      id: openbotUserId,
      email: email("one_identity"),
      name: "One identity person",
    });
    await store.link({
      provider: "slack",
      providerTenantId: teamId,
      providerUserId: "U901",
      openbotUserId,
      providerEmail: "first@example.com",
    });

    const error = await store
      .link({
        provider: "slack",
        providerTenantId: teamId,
        providerUserId: "U902",
        openbotUserId,
        providerEmail: "second@example.com",
      })
      .catch((reason: unknown) => reason);

    expectLinkConflict(error);
    const links = await database
      .select()
      .from(externalUserLinks)
      .where(
        and(
          eq(externalUserLinks.provider, "slack"),
          eq(externalUserLinks.providerTenantId, teamId),
          eq(externalUserLinks.openbotUserId, openbotUserId),
        ),
      );
    expect(links).toHaveLength(1);
    expect(links[0]?.providerUserId).toBe("U901");
  });

  test("returns one public conflict when Slack identities race for one OpenBot user", async () => {
    const openbotUserId = userId("racing_identities");
    const teamId = `T${suite}`;
    await createUser({
      id: openbotUserId,
      email: email("racing_identities"),
      name: "Racing identity person",
    });

    const results = await Promise.allSettled([
      store.link({
        provider: "slack",
        providerTenantId: teamId,
        providerUserId: "U903",
        openbotUserId,
        providerEmail: "first@example.com",
      }),
      store.link({
        provider: "slack",
        providerTenantId: teamId,
        providerUserId: "U904",
        openbotUserId,
        providerEmail: "second@example.com",
      }),
    ]);

    const successes = results.filter((result) => result.status === "fulfilled");
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expectLinkConflict(failures[0]?.reason);

    const links = await database
      .select()
      .from(externalUserLinks)
      .where(
        and(
          eq(externalUserLinks.provider, "slack"),
          eq(externalUserLinks.providerTenantId, teamId),
          eq(externalUserLinks.openbotUserId, openbotUserId),
        ),
      );
    expect(links).toHaveLength(1);
  });

  test("returns one public conflict when OpenBot users race for one Slack identity", async () => {
    const firstUserId = userId("racing_identity_first");
    const secondUserId = userId("racing_identity_second");
    const teamId = `T${suite}`;
    await createUser({
      id: firstUserId,
      email: email("racing_identity_first"),
      name: "First racing identity person",
    });
    await createUser({
      id: secondUserId,
      email: email("racing_identity_second"),
      name: "Second racing identity person",
    });

    const results = await Promise.allSettled([
      store.link({
        provider: "slack",
        providerTenantId: teamId,
        providerUserId: "U905",
        openbotUserId: firstUserId,
        providerEmail: "first@example.com",
      }),
      store.link({
        provider: "slack",
        providerTenantId: teamId,
        providerUserId: "U905",
        openbotUserId: secondUserId,
        providerEmail: "second@example.com",
      }),
    ]);

    const successes = results.filter((result) => result.status === "fulfilled");
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expectLinkConflict(failures[0]?.reason);

    const links = await database
      .select()
      .from(externalUserLinks)
      .where(
        and(
          eq(externalUserLinks.provider, "slack"),
          eq(externalUserLinks.providerTenantId, teamId),
          eq(externalUserLinks.providerUserId, "U905"),
        ),
      );
    expect(links).toHaveLength(1);
  });

  test("finds exactly one active verified OpenBot user by a normalized email", async () => {
    const openbotUserId = userId("normalized");
    const address = email("normalized");
    await createUser({
      id: openbotUserId,
      email: address,
      name: "Normalized person",
    });

    await expect(
      store.findVerifiedUserByEmail(`  ${address.toUpperCase()}  `),
    ).resolves.toEqual({ id: openbotUserId, name: "Normalized person" });
  });

  test("does not find an unverified OpenBot user by email", async () => {
    const openbotUserId = userId("unverified");
    const address = email("unverified");
    await createUser({
      id: openbotUserId,
      email: address,
      name: "Unverified person",
      emailVerified: false,
    });

    await expect(store.findVerifiedUserByEmail(address)).resolves.toBeNull();
  });

  test("excludes a user whose lower-cased email is revoked", async () => {
    const openbotUserId = userId("revoked");
    const address = email("revoked");
    await createUser({
      id: openbotUserId,
      email: address.toUpperCase(),
      name: "Revoked person",
    });
    const normalized = address.toLowerCase();
    createdRevocations.push(normalized);
    await database
      .insert(revokedAccess)
      .values({ email: normalized, revokedBy: "test" });

    await expect(store.findVerifiedUserByEmail(address)).resolves.toBeNull();
  });

  test("returns null for ambiguous active verified users", async () => {
    const firstUserId = userId("ambiguous_first");
    const secondUserId = userId("ambiguous_second");
    const address = email("ambiguous");
    await createUser({
      id: firstUserId,
      email: address,
      name: "First ambiguous person",
    });
    await createUser({
      id: secondUserId,
      email: address.toUpperCase(),
      name: "Second ambiguous person",
    });

    await expect(store.findVerifiedUserByEmail(address)).resolves.toBeNull();
  });

  test("reloads an active user with its effective role and refuses revoked or roleless accounts", async () => {
    const adminId = userId("active_admin");
    const rolelessId = userId("active_roleless");
    const revokedId = userId("active_revoked");
    const revokedEmail = email("active_revoked");
    await Promise.all([
      createUser({
        id: adminId,
        email: email("active_admin"),
        name: "Active admin",
      }),
      createUser({
        id: rolelessId,
        email: email("active_roleless"),
        name: "Roleless",
      }),
      createUser({ id: revokedId, email: revokedEmail, name: "Revoked" }),
    ]);
    await database.insert(userRoles).values([
      { userId: adminId, role: "user" },
      { userId: adminId, role: "admin" },
      { userId: revokedId, role: "user" },
    ]);
    const normalizedRevokedEmail = revokedEmail.toLowerCase();
    createdRevocations.push(normalizedRevokedEmail);
    await database
      .insert(revokedAccess)
      .values({ email: normalizedRevokedEmail, revokedBy: "test" });

    await expect(store.resolveActiveUser(adminId)).resolves.toEqual({
      id: adminId,
      name: "Active admin",
      role: "admin",
    });
    await expect(store.resolveActiveUser(rolelessId)).resolves.toBeNull();
    await expect(store.resolveActiveUser(revokedId)).resolves.toBeNull();
  });
});
