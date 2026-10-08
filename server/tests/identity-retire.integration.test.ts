import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { credentials, identityLinks } from "../src/db/schema";
import { retireIdentityLinks } from "../src/identity/retire";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const vault = createCredentialStore(database);
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

test("retiring a removed person's links revokes their tokens and keeps the rows", async () => {
  const userId = randomUUID();
  const credential = await vault.create({
    kind: "connector",
    provider: "github-user-token",
    keyId: randomUUID(),
    metadata: {},
    encryptedValue: "x",
  });
  createdCredentials.push(credential.id);
  const linkId = randomUUID();
  await database.insert(identityLinks).values({
    id: linkId,
    provider: "github",
    realm,
    subject: randomUUID(),
    userId,
    verifiedBy: "oauth",
    credentialId: credential.id,
    status: "active",
  });
  expect(await vault.isLive(credential.id)).toBe(true);

  expect(await retireIdentityLinks(database, vault, userId)).toBe(1);

  expect(await vault.isLive(credential.id)).toBe(false);
  const [row] = await database
    .select()
    .from(identityLinks)
    .where(eq(identityLinks.id, linkId));
  expect(row?.userId).toBe(userId);
  expect(row?.credentialId).toBeNull();
  expect(row?.status).toBe("needs_reconnect");

  expect(await retireIdentityLinks(database, vault, userId)).toBe(0);
});
