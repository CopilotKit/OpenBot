import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  credentials,
  identityLinkChallenges,
  identityLinks,
} from "../src/db/schema";
import {
  retireIdentityLinks,
  retireOwnedAccounts,
} from "../src/identity/retire";
import { createIdentityStore } from "../src/identity/store";
import { IdentityLinkError } from "../src/identity/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const vault = createCredentialStore(database);
const realm = `test-${randomUUID()}`;
const createdCredentials: string[] = [];
const users: string[] = [];
const ADMIN = "admin-remover";

afterAll(async () => {
  await database.delete(identityLinks).where(eq(identityLinks.realm, realm));
  if (users.length)
    await database
      .delete(identityLinkChallenges)
      .where(inArray(identityLinkChallenges.userId, users));
  if (createdCredentials.length)
    await database
      .delete(credentials)
      .where(inArray(credentials.id, createdCredentials));
  await database.$client.close();
});

const user = () => {
  const id = randomUUID();
  users.push(id);
  return id;
};

function recorder() {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = {
    insert: async (event) => {
      rows.push(event);
    },
  };
  return { rows, store };
}

const statusOf = async (linkId: string) =>
  (
    await database
      .select()
      .from(identityLinks)
      .where(eq(identityLinks.id, linkId))
  )[0];

test("retiring a removed person's links revokes their tokens and keeps the rows", async () => {
  const userId = user();
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
  const audit = recorder();

  expect(
    await retireIdentityLinks(database, vault, audit.store, userId, ADMIN),
  ).toBe(1);

  expect(await vault.isLive(credential.id)).toBe(false);
  const row = await statusOf(linkId);
  expect(row?.userId).toBe(userId);
  expect(row?.credentialId).toBeNull();
  expect(row?.status).toBe("needs_reconnect");

  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0]).toMatchObject({
    eventType: "identity.link_retired",
    targetType: "identity_link",
    targetId: linkId,
    actorUserId: ADMIN,
    payload: {
      actor: ADMIN,
      provider: "github",
      reason: "person_removed",
      credentialRevoked: true,
    },
  });
  const payload = JSON.stringify(audit.rows[0]?.payload);
  expect(payload).not.toContain(realm);
  expect(payload).not.toContain(credential.id);

  // A second pass changes nothing and records nothing.
  expect(
    await retireIdentityLinks(database, vault, audit.store, userId, ADMIN),
  ).toBe(0);
  expect(audit.rows).toHaveLength(1);
});

test("a link without a credential is also marked needs_reconnect, and audited without its subject", async () => {
  const userId = user();
  const linkId = randomUUID();
  const subject = `U-${randomUUID()}`;
  await database.insert(identityLinks).values({
    id: linkId,
    provider: "slack",
    realm,
    subject,
    userId,
    verifiedBy: "challenge",
    status: "active",
  });
  const audit = recorder();

  expect(
    await retireIdentityLinks(database, vault, audit.store, userId, ADMIN),
  ).toBe(1);

  const row = await statusOf(linkId);
  expect(row?.userId).toBe(userId);
  expect(row?.status).toBe("needs_reconnect");
  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0]).toMatchObject({
    eventType: "identity.link_retired",
    targetId: linkId,
    actorUserId: ADMIN,
    payload: {
      provider: "slack",
      reason: "person_removed",
      credentialRevoked: false,
    },
  });
  const payload = JSON.stringify(audit.rows[0]?.payload);
  expect(payload).not.toContain(subject);
  expect(payload).not.toContain(realm);
});

test("a pending challenge cannot be redeemed after the person is removed", async () => {
  const userId = user();
  const identities = createIdentityStore(database, vault);
  const { code } = await identities.issueChallenge(userId, "slack");

  await retireIdentityLinks(database, vault, recorder().store, userId, ADMIN);

  const pending = await database
    .select()
    .from(identityLinkChallenges)
    .where(eq(identityLinkChallenges.userId, userId));
  expect(pending).toHaveLength(0);
  await expect(
    identities.redeemChallenge(code, {
      provider: "slack",
      realm,
      subject: randomUUID(),
    }),
  ).rejects.toBeInstanceOf(IdentityLinkError);
});

test("a plugin refusal still retires identity links, and is rethrown", async () => {
  const refusal = new Error("composio refused");
  const ran: string[] = [];
  await expect(
    retireOwnedAccounts({
      plugins: async () => {
        ran.push("plugins");
        throw refusal;
      },
      identities: async () => {
        ran.push("identities");
        return 2;
      },
    }),
  ).rejects.toBe(refusal);
  expect(ran).toEqual(["plugins", "identities"]);
});

test("an identity failure still retires plugin connections, and is rethrown", async () => {
  const failure = new Error("vault down");
  const ran: string[] = [];
  await expect(
    retireOwnedAccounts({
      plugins: async () => {
        ran.push("plugins");
        return { retired: 1 };
      },
      identities: async () => {
        ran.push("identities");
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  expect(ran).toEqual(["plugins", "identities"]);
});

test("both failing surfaces both", async () => {
  const first = new Error("plugins");
  const second = new Error("identities");
  const error = await retireOwnedAccounts({
    plugins: async () => {
      throw first;
    },
    identities: async () => {
      throw second;
    },
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([first, second]);
});

test("both succeeding counts both", async () => {
  expect(
    await retireOwnedAccounts({
      plugins: async () => ({ retired: 2 }),
      identities: async () => 3,
    }),
  ).toEqual({ retired: 5 });
});
