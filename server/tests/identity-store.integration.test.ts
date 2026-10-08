import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { credentials, identityLinks } from "../src/db/schema";
import { createIdentityStore } from "../src/identity/store";
import {
  type Identity,
  IdentityConflictError,
  IdentityInputError,
} from "../src/identity/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const vault = createCredentialStore(database);
const store = createIdentityStore(database, vault);
const realm = `test-${randomUUID()}`;
const createdCredentials: string[] = [];

afterAll(async () => {
  await database.delete(identityLinks).where(eq(identityLinks.realm, realm));
  if (createdCredentials.length)
    await database
      .delete(credentials)
      .where(inArray(credentials.id, createdCredentials));
  await database.$client.close();
});

const github = (subject = randomUUID()): Identity => ({
  provider: "github",
  realm,
  subject,
});
const user = () => `user-${randomUUID()}`;

async function credential(
  kind: "connector" | "model" = "connector",
  provider = "github-user-token",
) {
  const { id } = await vault.create({
    kind,
    provider,
    keyId: randomUUID(),
    metadata: {},
    encryptedValue: "not-a-real-ciphertext",
  });
  createdCredentials.push(id);
  return id;
}

test("an unlinked identity resolves to null", async () => {
  expect(await store.linkedUser(github())).toBeNull();
});

test("linkVerified links, and linkedUser and identitiesFor read it back", async () => {
  const person = user();
  const identity = github();
  const link = await store.linkVerified(identity, person, {
    method: "oauth",
    handle: "dana",
  });
  expect(link.userId).toBe(person);
  expect(link.status).toBe("active");
  expect(await store.linkedUser(identity)).toEqual({
    userId: person,
    status: "active",
  });
  const mine = await store.identitiesFor(person, "github");
  expect(mine.map((row) => row.subject)).toEqual([identity.subject]);
  expect(await store.identitiesFor(person, "slack")).toEqual([]);
});

test("a method the provider does not declare is refused", async () => {
  await expect(
    store.linkVerified(github(), user(), { method: "challenge" }),
  ).rejects.toThrow(IdentityInputError);
});

test("an identity linked to somebody else is refused", async () => {
  const identity = github();
  await store.linkVerified(identity, user(), { method: "oauth" });
  await expect(
    store.linkVerified(identity, user(), { method: "oauth" }),
  ).rejects.toThrow(IdentityConflictError);
});

test("concurrent links of one identity by two people: exactly one wins", async () => {
  const identity = github();
  const results = await Promise.allSettled([
    store.linkVerified(identity, user(), { method: "oauth" }),
    store.linkVerified(identity, user(), { method: "oauth" }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((r) => r.status === "rejected");
  expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
    IdentityConflictError,
  );
});

test("relinking the same identity updates handle and credential, revoking the old one", async () => {
  const person = user();
  const identity = github();
  const first = await credential();
  await store.linkVerified(identity, person, {
    method: "oauth",
    handle: "old",
    credentialId: first,
  });
  const second = await credential();
  const link = await store.linkVerified(identity, person, {
    method: "oauth",
    handle: "new",
    credentialId: second,
  });
  expect(link.handle).toBe("new");
  expect(link.credentialId).toBe(second);
  expect(await vault.isLive(first)).toBe(false);
  expect(await vault.isLive(second)).toBe(true);
});

test("linkVerified replaces a person's older link in the same realm and revokes its credential", async () => {
  const person = user();
  const old = github();
  const oldCredential = await credential();
  await store.linkVerified(old, person, {
    method: "oauth",
    credentialId: oldCredential,
  });
  const replacement = github();
  await store.linkVerified(replacement, person, { method: "oauth" });
  expect(await store.linkedUser(old)).toBeNull();
  expect((await store.linkedUser(replacement))?.userId).toBe(person);
  expect(await vault.isLive(oldCredential)).toBe(false);
});

test("concurrent links by one person in one realm: the later replaces the earlier", async () => {
  const person = user();
  const [first, second] = [await credential(), await credential()] as [
    string,
    string,
  ];
  const [a, b] = [github(), github()];
  const [linkA, linkB] = await Promise.all([
    store.linkVerified(a, person, { method: "oauth", credentialId: first }),
    store.linkVerified(b, person, { method: "oauth", credentialId: second }),
  ]);
  const mine = (await store.identitiesFor(person, "github")).filter(
    (row) => row.realm === realm,
  );
  expect(mine).toHaveLength(1);
  const [remaining] = mine;
  expect([linkA.id, linkB.id]).toContain(remaining?.id);
  expect([first, second]).toContain(remaining?.credentialId as string);
  const loser = remaining?.credentialId === first ? second : first;
  expect(await vault.isLive(remaining?.credentialId as string)).toBe(true);
  expect(await vault.isLive(loser)).toBe(false);
});

test("relinking without a credentialId keeps the stored token live and on the link", async () => {
  const person = user();
  const identity = github();
  const token = await credential();
  await store.linkVerified(identity, person, {
    method: "oauth",
    handle: "dana",
    credentialId: token,
  });
  const link = await store.linkVerified(identity, person, { method: "oauth" });
  expect(link.credentialId).toBe(token);
  expect(link.handle).toBe("dana");
  expect(await vault.isLive(token)).toBe(true);
});

test("relinking with an explicit null handle clears it", async () => {
  const person = user();
  const identity = github();
  await store.linkVerified(identity, person, {
    method: "oauth",
    handle: "dana",
  });
  const link = await store.linkVerified(identity, person, {
    method: "oauth",
    handle: null,
  });
  expect(link.handle).toBeNull();
});

test("a credential already on another link is refused and stays live", async () => {
  const token = await credential();
  const owner = await store.linkVerified(github(), user(), {
    method: "oauth",
    credentialId: token,
  });
  const identity = github();
  await expect(
    store.linkVerified(identity, user(), {
      method: "oauth",
      credentialId: token,
    }),
  ).rejects.toThrow(IdentityInputError);
  expect(await store.linkedUser(identity)).toBeNull();
  expect(await vault.isLive(token)).toBe(true);
  const [still] = await database
    .select({ credentialId: identityLinks.credentialId })
    .from(identityLinks)
    .where(eq(identityLinks.id, owner.id));
  expect(still?.credentialId).toBe(token);
});

test("a credentialId that is not a UUID is refused before any query", async () => {
  const identity = github();
  const attempt = store.linkVerified(identity, user(), {
    method: "oauth",
    credentialId: "not-a-uuid",
  });
  await expect(attempt).rejects.toThrow(IdentityInputError);
  await expect(attempt).rejects.not.toThrow(/not-a-uuid/);
  expect(await store.linkedUser(identity)).toBeNull();
});

test("replacing a person's older link while moving its credential to the new one keeps it live", async () => {
  const person = user();
  const old = github();
  const token = await credential();
  await store.linkVerified(old, person, {
    method: "oauth",
    credentialId: token,
  });
  const replacement = github();
  const link = await store.linkVerified(replacement, person, {
    method: "oauth",
    credentialId: token,
  });
  expect(await store.linkedUser(old)).toBeNull();
  expect(link.credentialId).toBe(token);
  expect(await vault.isLive(token)).toBe(true);
});

test("markNeedsReconnect is visible to linkedUser; relinking makes it active again", async () => {
  const person = user();
  const identity = github();
  const link = await store.linkVerified(identity, person, { method: "oauth" });
  await store.markNeedsReconnect(link.id);
  expect((await store.linkedUser(identity))?.status).toBe("needs_reconnect");
  await store.linkVerified(identity, person, { method: "oauth" });
  expect((await store.linkedUser(identity))?.status).toBe("active");
});

test("unlink removes only the asker's own link and revokes its credential", async () => {
  const person = user();
  const identity = github();
  const token = await credential();
  const link = await store.linkVerified(identity, person, {
    method: "oauth",
    credentialId: token,
  });
  expect(await store.unlink(user(), link.id)).toBeNull();
  expect(await store.linkedUser(identity)).not.toBeNull();
  expect(await store.unlink(person, link.id)).toEqual({
    provider: "github",
  });
  expect(await store.linkedUser(identity)).toBeNull();
  expect(await vault.isLive(token)).toBe(false);
  expect(await store.unlink(person, link.id)).toBeNull();
});

test("a link outlives its user: nothing cascades from users", async () => {
  const identity = github();
  await store.linkVerified(identity, "user-that-never-existed", {
    method: "oauth",
  });
  expect((await store.linkedUser(identity))?.userId).toBe(
    "user-that-never-existed",
  );
});

test("identitiesFor skips a link whose provider the registry does not know", async () => {
  const person = user();
  const valid = await store.linkVerified(github(), person, {
    method: "oauth",
  });
  await database.insert(identityLinks).values({
    id: randomUUID(),
    provider: "myspace",
    realm,
    subject: randomUUID(),
    userId: person,
    verifiedBy: "oauth",
    status: "active",
  });
  const links = await store.identitiesFor(person);
  expect(links.map((link) => link.id)).toEqual([valid.id]);
});

test("a credential that does not exist is refused and no link is written", async () => {
  const identity = github();
  await expect(
    store.linkVerified(identity, user(), {
      method: "oauth",
      credentialId: randomUUID(),
    }),
  ).rejects.toThrow(IdentityInputError);
  expect(await store.linkedUser(identity)).toBeNull();
});

test("a revoked credential is refused and no link is written", async () => {
  const identity = github();
  const id = await credential();
  await vault.revoke(id);
  await expect(
    store.linkVerified(identity, user(), {
      method: "oauth",
      credentialId: id,
    }),
  ).rejects.toThrow(IdentityInputError);
  expect(await store.linkedUser(identity)).toBeNull();
});

test("a challenge link refuses a credential", async () => {
  const identity: Identity = {
    provider: "slack",
    realm,
    subject: randomUUID(),
  };
  await expect(
    store.linkVerified(identity, user(), {
      method: "challenge",
      credentialId: await credential(),
    }),
  ).rejects.toThrow(IdentityInputError);
  expect(await store.linkedUser(identity)).toBeNull();
});

test("a live credential of another kind is refused and stays live", async () => {
  const identity = github();
  const operatorKey = await credential("model");
  await expect(
    store.linkVerified(identity, user(), {
      method: "oauth",
      credentialId: operatorKey,
    }),
  ).rejects.toThrow("The credential for this link is not available.");
  expect(await store.linkedUser(identity)).toBeNull();
  expect(await vault.isLive(operatorKey)).toBe(true);
});

test("a connector credential for another provider is refused and stays live", async () => {
  const identity = github();
  const person = user();
  const other = await credential("connector", "slack-bot-token");
  await expect(
    store.linkVerified(identity, person, {
      method: "oauth",
      credentialId: other,
    }),
  ).rejects.toThrow("The credential for this link is not available.");
  expect(await store.linkedUser(identity)).toBeNull();
  expect(await vault.isLive(other)).toBe(true);
  // Relinking an existing link with it is refused too, and the link's own token survives.
  const own = await credential();
  await store.linkVerified(identity, person, {
    method: "oauth",
    credentialId: own,
  });
  await expect(
    store.linkVerified(identity, person, {
      method: "oauth",
      credentialId: other,
    }),
  ).rejects.toThrow(IdentityInputError);
  expect(await vault.isLive(other)).toBe(true);
  expect(await vault.isLive(own)).toBe(true);
});

test("a linked handle is capped at 256 code points like a redeemed one", async () => {
  const link = await store.linkVerified(github(), user(), {
    method: "oauth",
    handle: `${"a".repeat(255)}\u{1F600}\u{1F600}`,
  });
  expect(link.handle).toBe(`${"a".repeat(255)}\u{1F600}`);
});

test("a blank linked handle is stored as none, and a non-string one is refused", async () => {
  const blank = await store.linkVerified(github(), user(), {
    method: "oauth",
    handle: " ",
  });
  expect(blank.handle).toBeNull();
  const identity = github();
  await expect(
    store.linkVerified(identity, user(), {
      method: "oauth",
      handle: { name: "dana" } as unknown as string,
    }),
  ).rejects.toThrow(IdentityInputError);
  expect(await store.linkedUser(identity)).toBeNull();
});

test("an uppercase credentialId is kept on relink, not revoked as a different token", async () => {
  const person = user();
  const identity = github();
  const token = await credential();
  await store.linkVerified(identity, person, {
    method: "oauth",
    credentialId: token.toUpperCase(),
  });
  const link = await store.linkVerified(identity, person, {
    method: "oauth",
    credentialId: token.toUpperCase(),
  });
  expect(link.credentialId).toBe(token);
  expect(await vault.isLive(token)).toBe(true);
});

test.each([42, null, " user-padded", "user-padded "])(
  "a userId of %p is refused as input",
  async (userId) => {
    const identity = github();
    await expect(
      store.linkVerified(identity, userId as unknown as string, {
        method: "oauth",
      }),
    ).rejects.toThrow(IdentityInputError);
    expect(await store.linkedUser(identity)).toBeNull();
  },
);
