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

async function credential() {
  const { id } = await vault.create({
    kind: "connector",
    provider: "github-user-token",
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
  const live = [first, second].filter((id) => id === remaining?.credentialId);
  expect(live).toHaveLength(1);
  const liveness = await Promise.all(
    [first, second].map((id) => vault.isLive(id)),
  );
  expect(liveness.filter(Boolean)).toHaveLength(1);
  expect(await vault.isLive(remaining?.credentialId as string)).toBe(true);
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
  expect(await store.unlink(user(), link.id)).toBe(false);
  expect(await store.linkedUser(identity)).not.toBeNull();
  expect(await store.unlink(person, link.id)).toBe(true);
  expect(await store.linkedUser(identity)).toBeNull();
  expect(await vault.isLive(token)).toBe(false);
  expect(await store.unlink(person, link.id)).toBe(false);
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
