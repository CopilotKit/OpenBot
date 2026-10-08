import { afterAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { identityLinkChallenges, identityLinks } from "../src/db/schema";
import { createIdentityStore } from "../src/identity/store";
import {
  type Identity,
  IdentityConflictError,
  IdentityInputError,
  IdentityLinkError,
  type IdentityProvider,
} from "../src/identity/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createIdentityStore(database, createCredentialStore(database));
const realm = `test-${randomUUID()}`;
const users: string[] = [];

afterAll(async () => {
  if (users.length)
    await database
      .delete(identityLinkChallenges)
      .where(inArray(identityLinkChallenges.userId, users));
  await database.delete(identityLinks).where(eq(identityLinks.realm, realm));
  await database.$client.close();
});

const user = () => {
  const id = `user-${randomUUID()}`;
  users.push(id);
  return id;
};
const slack = (subject = randomUUID()): Identity => ({
  provider: "slack",
  realm,
  subject,
});
const hashOf = (code: string) =>
  createHash("sha256").update(code).digest("hex");
const rowFor = async (code: string) =>
  (
    await database
      .select()
      .from(identityLinkChallenges)
      .where(eq(identityLinkChallenges.tokenHash, hashOf(code)))
  )[0];
const expire = (code: string, by = "1 second") =>
  database
    .update(identityLinkChallenges)
    .set({ expiresAt: sql`clock_timestamp() - ${by}::interval` })
    .where(eq(identityLinkChallenges.tokenHash, hashOf(code)));
const dbNow = async () => {
  const result = await database.execute<{ now: string | Date }>(
    sql`select clock_timestamp() as now`,
  );
  const rows = Array.isArray(result)
    ? result
    : (result as { rows: unknown[] }).rows;
  return new Date((rows[0] as { now: string | Date }).now).getTime();
};

test("a code is a UUID, only its hash is stored, and it lasts ten minutes", async () => {
  const owner = user();
  const before = await dbNow();
  const { code, expiresAt } = await store.issueChallenge(owner, "slack");
  const after = await dbNow();
  expect(code).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 600_000);
  expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 600_000);
  const saved = await rowFor(code);
  expect(saved).toEqual({
    tokenHash: hashOf(code),
    provider: "slack",
    userId: owner,
    expiresAt,
  });
  expect(JSON.stringify(saved)).not.toContain(code);
});

test("a provider that does not accept challenges cannot issue a code", async () => {
  await expect(store.issueChallenge(user(), "github")).rejects.toThrow(
    IdentityInputError,
  );
  await expect(
    store.issueChallenge(user(), "myspace" as IdentityProvider),
  ).rejects.toThrow(IdentityInputError);
  await expect(store.issueChallenge(" ", "slack")).rejects.toThrow(
    IdentityInputError,
  );
});

test("redeeming links the chat account to the person the code was issued to", async () => {
  // The fixation regression: whoever sends the code, the link belongs to the issuer.
  const owner = user();
  const sender = slack();
  const { code } = await store.issueChallenge(owner, "slack");
  const link = await store.redeemChallenge(code, sender, "dana");
  expect(link.userId).toBe(owner);
  expect(link.verifiedBy).toBe("challenge");
  expect(link.handle).toBe("dana");
  expect(await store.linkedUser(sender)).toEqual({
    userId: owner,
    status: "active",
  });
  expect(await rowFor(code)).toBeUndefined();
});

test("extra properties on the chat identity cannot redirect the link", async () => {
  const owner = user();
  const sender = { ...slack(), userId: "forged-user" };
  const { code } = await store.issueChallenge(owner, "slack");
  expect((await store.redeemChallenge(code, sender)).userId).toBe(owner);
});

test("a code is consumed once", async () => {
  const { code } = await store.issueChallenge(user(), "slack");
  await store.redeemChallenge(code, slack());
  const other = slack();
  await expect(store.redeemChallenge(code, other)).rejects.toThrow(
    IdentityLinkError,
  );
  expect(await store.linkedUser(other)).toBeNull();
});

test("a code from another provider is refused without consuming it", async () => {
  const owner = user();
  const { code } = await store.issueChallenge(owner, "slack");
  const wrong: Identity = { provider: "github", realm, subject: randomUUID() };
  await expect(store.redeemChallenge(code, wrong)).rejects.toThrow(
    IdentityLinkError,
  );
  expect(await store.linkedUser(wrong)).toBeNull();
  expect(await rowFor(code)).toBeDefined();
  expect((await store.redeemChallenge(code, slack())).userId).toBe(owner);
});

test("an expired code is refused", async () => {
  const { code } = await store.issueChallenge(user(), "slack");
  await expire(code);
  const sender = slack();
  await expect(store.redeemChallenge(code, sender)).rejects.toThrow(
    IdentityLinkError,
  );
  expect(await store.linkedUser(sender)).toBeNull();
});

test.each([
  "",
  "short",
  "link 123e4567-e89b-42d3-a456-426614174000",
  "123e4567e89b42d3a456426614174000",
  "' or 1=1 --",
])("a malformed code %p is refused", async (code) => {
  await expect(store.redeemChallenge(code, slack())).rejects.toThrow(
    IdentityLinkError,
  );
});

test("an unknown but well-formed code is refused", async () => {
  await expect(store.redeemChallenge(randomUUID(), slack())).rejects.toThrow(
    IdentityLinkError,
  );
});

test("issuing again invalidates the person's previous code for that provider", async () => {
  const owner = user();
  const first = await store.issueChallenge(owner, "slack");
  const second = await store.issueChallenge(owner, "slack");
  expect(await rowFor(first.code)).toBeUndefined();
  await expect(store.redeemChallenge(first.code, slack())).rejects.toThrow(
    IdentityLinkError,
  );
  expect((await store.redeemChallenge(second.code, slack())).userId).toBe(
    owner,
  );
});

test("issuing for one person leaves other people's codes alone", async () => {
  const mine = await store.issueChallenge(user(), "slack");
  await store.issueChallenge(user(), "slack");
  expect(await rowFor(mine.code)).toBeDefined();
});

test("issuing sweeps codes expired over a day ago and keeps recently expired ones", async () => {
  const staleOwner = user();
  const recentOwner = user();
  const stale = await store.issueChallenge(staleOwner, "slack");
  const recent = await store.issueChallenge(recentOwner, "slack");
  await expire(stale.code, "2 days");
  await expire(recent.code, "1 hour");
  await store.issueChallenge(user(), "slack");
  expect(await rowFor(stale.code)).toBeUndefined();
  expect(await rowFor(recent.code)).toBeDefined();
});

test("a chat account linked to somebody else is refused and the code stays unused", async () => {
  const sender = slack();
  const first = user();
  const second = user();
  const one = await store.issueChallenge(first, "slack");
  await store.redeemChallenge(one.code, sender);
  const two = await store.issueChallenge(second, "slack");
  await expect(store.redeemChallenge(two.code, sender)).rejects.toThrow(
    IdentityConflictError,
  );
  expect((await store.linkedUser(sender))?.userId).toBe(first);
  expect(await rowFor(two.code)).toBeDefined();
  expect((await store.redeemChallenge(two.code, slack())).userId).toBe(second);
});

test("redeeming a second code in the same realm replaces the person's older link", async () => {
  const owner = user();
  const first = slack();
  const second = slack();
  await store.redeemChallenge(
    (await store.issueChallenge(owner, "slack")).code,
    first,
  );
  await store.redeemChallenge(
    (await store.issueChallenge(owner, "slack")).code,
    second,
  );
  expect(await store.linkedUser(first)).toBeNull();
  expect((await store.linkedUser(second))?.userId).toBe(owner);
});

test("concurrent requests still leave one live code per person and provider", async () => {
  const owner = user();
  const issued = await Promise.all(
    Array.from({ length: 10 }, () => store.issueChallenge(owner, "slack")),
  );
  const rows = await database
    .select()
    .from(identityLinkChallenges)
    .where(eq(identityLinkChallenges.userId, owner));
  expect(rows).toHaveLength(1);
  const live = issued.filter(({ code }) => hashOf(code) === rows[0]?.tokenHash);
  expect(live).toHaveLength(1);
  for (const { code } of issued) {
    if (code === live[0]?.code) continue;
    await expect(store.redeemChallenge(code, slack())).rejects.toBeInstanceOf(
      IdentityLinkError,
    );
  }
  expect(
    (await store.redeemChallenge(live[0]?.code ?? "", slack())).userId,
  ).toBe(owner);
});

test("redeeming again without a handle keeps the stored one; an explicit null clears it", async () => {
  const owner = user();
  const sender = slack();
  const issue = async () => (await store.issueChallenge(owner, "slack")).code;
  await store.redeemChallenge(await issue(), sender, "dana");
  expect((await store.redeemChallenge(await issue(), sender)).handle).toBe(
    "dana",
  );
  expect(
    (await store.redeemChallenge(await issue(), sender, undefined)).handle,
  ).toBe("dana");
  expect(
    (await store.redeemChallenge(await issue(), sender, null)).handle,
  ).toBeNull();
});

test("a redeemed handle is capped at 256 code points without splitting a pair", async () => {
  const owner = user();
  const link = await store.redeemChallenge(
    (await store.issueChallenge(owner, "slack")).code,
    slack(),
    "\u{1F600}".repeat(300),
  );
  expect(Array.from(link.handle ?? "")).toHaveLength(256);
  expect(link.handle).toBe("\u{1F600}".repeat(256));
});

test("a blank redeemed handle is stored as none, and a non-string one is refused", async () => {
  const owner = user();
  const link = await store.redeemChallenge(
    (await store.issueChallenge(owner, "slack")).code,
    slack(),
    "   ",
  );
  expect(link.handle).toBeNull();
  const { code } = await store.issueChallenge(owner, "slack");
  await expect(
    store.redeemChallenge(code, slack(), 42 as unknown as string),
  ).rejects.toThrow(IdentityInputError);
  expect(await rowFor(code)).toBeDefined();
});
