import { afterAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { identityLinkChallenges, identityLinks } from "../src/db/schema";
import { createIdentityStore } from "../src/identity/store";
import {
  type Identity,
  IdentityInputError,
  IdentityLinkError,
} from "../src/identity/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createIdentityStore(database, createCredentialStore(database));
const realm = `test-${randomUUID()}`;

afterAll(async () => {
  await database
    .delete(identityLinkChallenges)
    .where(eq(identityLinkChallenges.realm, realm));
  await database.delete(identityLinks).where(eq(identityLinks.realm, realm));
  await database.$client.close();
});

const slack = (subject = randomUUID()): Identity => ({
  provider: "slack",
  realm,
  subject,
});

test("extra identity properties cannot pre-confirm an application account", async () => {
  const sender = { ...slack(), confirmedUserId: "forged-user" };
  const { token } = await store.beginChallenge(sender);
  await expect(store.completeChallenge(token, sender)).rejects.toThrow(
    IdentityLinkError,
  );
  expect(await store.linkedUser(sender)).toBeNull();
});

test("a provider that does not accept challenges cannot begin one", async () => {
  await expect(
    store.beginChallenge({ provider: "github", realm, subject: "1" }),
  ).rejects.toThrow(IdentityInputError);
});

test("linking needs both confirmations, stores only a hash, and consumes once", async () => {
  const sender = slack();
  const before = Date.now();
  const challenge = await store.beginChallenge(sender, "dana");
  expect(Buffer.from(challenge.token, "base64url").length).toBe(32);
  expect(challenge.expiresAt.getTime()).toBeGreaterThanOrEqual(
    before + 599_000,
  );
  expect(challenge.expiresAt.getTime()).toBeLessThanOrEqual(
    Date.now() + 600_000,
  );
  const [saved] = await database
    .select()
    .from(identityLinkChallenges)
    .where(
      eq(
        identityLinkChallenges.tokenHash,
        createHash("sha256").update(challenge.token).digest("hex"),
      ),
    );
  expect(saved).toBeDefined();
  expect(JSON.stringify(saved)).not.toContain(challenge.token);
  expect(await store.peekChallenge(challenge.token)).toEqual({
    provider: "slack",
    handle: "dana",
  });
  await expect(
    store.completeChallenge(challenge.token, sender),
  ).rejects.toThrow(IdentityLinkError);
  await store.confirmChallenge(challenge.token, "user-a");
  await store.confirmChallenge(challenge.token, "user-a");
  expect(await store.linkedUser(sender)).toBeNull();
  const link = await store.completeChallenge(challenge.token, sender);
  expect(link.verifiedBy).toBe("challenge");
  expect(link.handle).toBe("dana");
  expect((await store.linkedUser(sender))?.userId).toBe("user-a");
  await expect(
    store.completeChallenge(challenge.token, sender),
  ).rejects.toThrow(IdentityLinkError);
  await expect(
    store.confirmChallenge(challenge.token, "user-a"),
  ).rejects.toThrow(IdentityLinkError);
  expect(await store.peekChallenge(challenge.token)).toBeNull();
});

test("confirmation cannot change the signed-in application user", async () => {
  const sender = slack();
  const { token } = await store.beginChallenge(sender);
  const results = await Promise.allSettled([
    store.confirmChallenge(token, "user-a"),
    store.confirmChallenge(token, "user-b"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  await store.completeChallenge(token, sender);
  expect(["user-a", "user-b"]).toContain(
    (await store.linkedUser(sender))?.userId,
  );
});

test.each(["provider", "realm", "subject"] as const)(
  "a challenge refuses a different %s without consuming it",
  async (field) => {
    const sender = slack();
    const { token } = await store.beginChallenge(sender);
    await store.confirmChallenge(token, "user-a");
    const other =
      field === "provider"
        ? { ...sender, provider: "github" as const }
        : { ...sender, [field]: "other" };
    await expect(store.completeChallenge(token, other)).rejects.toThrow();
    await store.completeChallenge(token, sender);
    expect((await store.linkedUser(sender))?.userId).toBe("user-a");
  },
);

const hashOf = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const expire = (token: string) =>
  database
    .update(identityLinkChallenges)
    .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(identityLinkChallenges.tokenHash, hashOf(token)));

test("an expired challenge can be neither peeked, confirmed nor completed", async () => {
  const sender = slack();
  const confirmed = await store.beginChallenge(sender);
  await store.confirmChallenge(confirmed.token, "user-a");
  await expire(confirmed.token);
  expect(await store.peekChallenge(confirmed.token)).toBeNull();
  await expect(
    store.completeChallenge(confirmed.token, sender),
  ).rejects.toThrow(IdentityLinkError);

  const unconfirmed = await store.beginChallenge(slack());
  await expire(unconfirmed.token);
  expect(await store.peekChallenge(unconfirmed.token)).toBeNull();
  await expect(
    store.confirmChallenge(unconfirmed.token, "user-a"),
  ).rejects.toThrow(IdentityLinkError);
});

test("beginning a challenge clears challenges that expired over a day ago", async () => {
  const stale = `stale-${randomUUID()}`;
  await database.insert(identityLinkChallenges).values({
    tokenHash: stale,
    provider: "slack",
    realm,
    subject: randomUUID(),
    expiresAt: sql`clock_timestamp() - interval '2 days'`,
  });
  await store.beginChallenge(slack());
  const rows = await database
    .select()
    .from(identityLinkChallenges)
    .where(eq(identityLinkChallenges.tokenHash, stale));
  expect(rows).toEqual([]);
});

test("a malformed token is refused before any query", async () => {
  await expect(store.confirmChallenge("short", "user-a")).rejects.toThrow(
    IdentityLinkError,
  );
  expect(await store.peekChallenge("short")).toBeNull();
});

test("completing a second challenge in the same realm replaces the person's older link", async () => {
  const first = slack();
  const one = await store.beginChallenge(first);
  await store.confirmChallenge(one.token, "user-z");
  await store.completeChallenge(one.token, first);
  const second = slack();
  const two = await store.beginChallenge(second);
  await store.confirmChallenge(two.token, "user-z");
  await store.completeChallenge(two.token, second);
  expect(await store.linkedUser(first)).toBeNull();
  expect((await store.linkedUser(second))?.userId).toBe("user-z");
});
