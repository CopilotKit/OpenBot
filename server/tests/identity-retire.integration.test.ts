import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import {
  type AuditEventInput,
  type AuditStore,
  createAuditStore,
} from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  credentials,
  identityLinkChallenges,
  identityLinks,
} from "../src/db/schema";
import {
  retireIdentityLinks,
  retireOwnedAccounts,
} from "../src/identity/retire";
import { createIdentityStore, identityUserLock } from "../src/identity/store";
import { IdentityLinkError } from "../src/identity/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const vault = createCredentialStore(database);
const realm = `test-${randomUUID()}`;
const createdCredentials: string[] = [];
const users: string[] = [];
const ADMIN = "admin-remover";

afterAll(async () => {
  await database
    .delete(identityLinks)
    .where(like(identityLinks.realm, `${realm}%`));
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
    await retireIdentityLinks(
      database,
      vault,
      () => audit.store,
      userId,
      ADMIN,
    ),
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
    await retireIdentityLinks(
      database,
      vault,
      () => audit.store,
      userId,
      ADMIN,
    ),
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
    await retireIdentityLinks(
      database,
      vault,
      () => audit.store,
      userId,
      ADMIN,
    ),
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

test("an audit row that fails to write rolls the retirement back, so a retry retires and audits every link", async () => {
  const userId = user();
  const linkIds = [randomUUID(), randomUUID()];
  for (const id of linkIds)
    await database.insert(identityLinks).values({
      id,
      provider: "slack",
      realm: `${realm}-${id}`,
      subject: randomUUID(),
      userId,
      verifiedBy: "challenge",
      status: "active",
    });
  let written = 0;
  const failing: AuditStore = {
    insert: async () => {
      written += 1;
      if (written === 2) throw new Error("audit store down");
    },
  };

  await expect(
    retireIdentityLinks(database, vault, () => failing, userId, ADMIN),
  ).rejects.toThrow("audit store down");
  for (const id of linkIds) expect((await statusOf(id))?.status).toBe("active");

  const audit = recorder();
  expect(
    await retireIdentityLinks(
      database,
      vault,
      () => audit.store,
      userId,
      ADMIN,
    ),
  ).toBe(2);
  expect(audit.rows.map((row) => row.targetId).sort()).toEqual(
    [...linkIds].sort(),
  );
  for (const id of linkIds)
    expect((await statusOf(id))?.status).toBe("needs_reconnect");
});

test("the audit trail's own store writes the rows inside the retirement's transaction", async () => {
  const userId = user();
  const linkId = randomUUID();
  await database.insert(identityLinks).values({
    id: linkId,
    provider: "slack",
    realm,
    subject: randomUUID(),
    userId,
    verifiedBy: "challenge",
    status: "active",
  });

  expect(
    await retireIdentityLinks(
      database,
      vault,
      (executor) => createAuditStore(executor),
      userId,
      ADMIN,
    ),
  ).toBe(1);

  const rows = await database
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.targetId, linkId));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.eventType).toBe("identity.link_retired");
});

test("a pending challenge cannot be redeemed after the person is removed", async () => {
  const userId = user();
  const identities = createIdentityStore(database, vault);
  const { code } = await identities.issueChallenge(userId, "slack");

  await retireIdentityLinks(
    database,
    vault,
    () => recorder().store,
    userId,
    ADMIN,
  );

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

test("retirement waits on the per-person identity lock that issuing a code takes", async () => {
  const userId = user();
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked = () => {};
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = database.transaction(async (transaction) => {
    await identityUserLock(transaction, userId);
    locked();
    await released;
  });
  await isLocked;
  let finished = false;
  const retiring = retireIdentityLinks(
    database,
    vault,
    () => recorder().store,
    userId,
    ADMIN,
  ).then((count) => {
    finished = true;
    return count;
  });
  await Bun.sleep(200);
  expect(finished).toBe(false);
  release();
  await holder;
  expect(await retiring).toBe(0);
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
