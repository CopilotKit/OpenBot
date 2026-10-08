import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  credentials,
  identityLinkChallenges,
  identityLinks,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const credentialStore = createCredentialStore(database);
const realm = `test-${randomUUID()}`;
const challengeUsers = [`user-${randomUUID()}`];
const credentialIds: string[] = [];

afterAll(async () => {
  await database.delete(identityLinks).where(eq(identityLinks.realm, realm));
  await database
    .delete(identityLinkChallenges)
    .where(inArray(identityLinkChallenges.userId, challengeUsers));
  if (credentialIds.length > 0)
    await database
      .delete(credentials)
      .where(inArray(credentials.id, credentialIds));
  await database.$client.close();
});

/**
 * Which constraint a rejected write tripped. Drizzle wraps the driver error, so SQLSTATE and
 * constraint name sit on `cause`. A bare `rejects.toThrow()` would pass on any failure at all.
 */
async function violation(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error("expected the write to be rejected");
    },
    (caught: unknown) => caught,
  );
  const driver = (error as { cause?: unknown }).cause ?? error;
  const { errno, constraint } = driver as {
    errno?: unknown;
    constraint?: unknown;
  };
  return { sqlState: errno, constraint };
}

const row = (subject: string, userId: string) => ({
  id: randomUUID(),
  provider: "slack",
  realm,
  subject,
  userId,
  verifiedBy: "challenge" as const,
});

test("an outside account links to one user", async () => {
  await database.insert(identityLinks).values(row("U1", "user-a"));
  expect(
    await violation(
      database.insert(identityLinks).values(row("U1", "user-b")).execute(),
    ),
  ).toEqual({ sqlState: "23505", constraint: "identity_links_identity_idx" });
});

test("a user has one account per provider and realm", async () => {
  await database.insert(identityLinks).values(row("U2", "user-c"));
  expect(
    await violation(
      database.insert(identityLinks).values(row("U3", "user-c")).execute(),
    ),
  ).toEqual({ sqlState: "23505", constraint: "identity_links_user_realm_idx" });
});

test("one credential belongs to one link", async () => {
  const { id } = await credentialStore.create({
    kind: "connector",
    provider: "github-user-token",
    keyId: randomUUID(),
    metadata: {},
    encryptedValue: "x",
  });
  credentialIds.push(id);
  await database
    .insert(identityLinks)
    .values({ ...row("U6", "user-f"), credentialId: id });
  expect(
    await violation(
      database
        .insert(identityLinks)
        .values({ ...row("U7", "user-g"), credentialId: id })
        .execute(),
    ),
  ).toEqual({ sqlState: "23505", constraint: "identity_links_credential_idx" });
});

test("a user has one live link code per provider", async () => {
  const userId = challengeUsers[0] as string;
  const challenge = () => ({
    tokenHash: randomUUID(),
    provider: "slack",
    userId,
    expiresAt: new Date(Date.now() + 600_000),
  });
  await database.insert(identityLinkChallenges).values(challenge());
  expect(
    await violation(
      database.insert(identityLinkChallenges).values(challenge()).execute(),
    ),
  ).toEqual({
    sqlState: "23505",
    constraint: "identity_link_challenges_user_provider_idx",
  });
});

test("verified_by and status are constrained", async () => {
  expect(
    await violation(
      database
        .insert(identityLinks)
        .values({ ...row("U4", "user-d"), verifiedBy: "guess" as never })
        .execute(),
    ),
  ).toEqual({
    sqlState: "23514",
    constraint: "identity_links_verified_by_check",
  });
  expect(
    await violation(
      database
        .insert(identityLinks)
        .values({ ...row("U5", "user-e"), status: "gone" as never })
        .execute(),
    ),
  ).toEqual({ sqlState: "23514", constraint: "identity_links_status_check" });
});
