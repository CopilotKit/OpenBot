import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  type AuditEventInput,
  type AuditStore,
  createAuditStore,
} from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { identityLinkChallenges } from "../src/db/schema";
import {
  retireIdentityLinks,
  retireOwnedAccounts,
} from "../src/identity/retire";
import { createIdentityStore, identityUserLock } from "../src/identity/store";
import { IdentityLinkError } from "../src/identity/types";
import { idempotencyKey } from "../src/people/directory/client";
import { auditRows } from "./support/audit";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  purgeDirectoryPeople,
  seedDirectoryPerson,
  useTestPeople,
} from "./support/directory";
import { purgeSecrets, useTestVault } from "./support/vault";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
let vault: ReturnType<typeof createCredentialStore>;
const realm = `test-${randomUUID()}`;
const createdCredentials: string[] = [];
const users: string[] = [];
const ADMIN = "admin-remover";

// Links live in Intelligence's organization directory, and belong to people it holds.
const directory = useTestPeople();

beforeAll(async () => {
  vault = createCredentialStore(await useTestVault());
});

afterAll(async () => {
  // Purging a person takes their links with them.
  await purgeDirectoryPeople(users);
  if (users.length)
    await database
      .delete(identityLinkChallenges)
      .where(inArray(identityLinkChallenges.userId, users));
  await purgeSecrets(createdCredentials.splice(0));
  await database.$client.close();
});

/** A person the directory holds, for links to belong to. */
async function user() {
  const { id } = await seedDirectoryPerson();
  users.push(id);
  return id;
}

/** A link as a person would have made it, in the directory. Returns its id. */
async function insertLink(values: {
  provider: string;
  realm: string;
  subject: string;
  userId: string;
  verifiedBy: "challenge" | "oauth";
  credentialId?: string;
  status: "active" | "needs_reconnect";
}): Promise<string> {
  const { identity } = await directory.client.linkIdentity(
    {
      userId: values.userId,
      provider: values.provider,
      realm: values.realm,
      subject: values.subject,
      verifiedBy: values.verifiedBy,
      ...(values.credentialId ? { credentialId: values.credentialId } : {}),
    },
    idempotencyKey("test-link"),
  );
  if (values.status === "needs_reconnect")
    await directory.client.updateIdentity(
      identity.id,
      { status: "needs_reconnect" },
      idempotencyKey("test-link-status"),
    );
  return identity.id;
}

function recorder() {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = {
    insert: async (event) => {
      rows.push(event);
    },
  };
  return { rows, store };
}

const statusOf = async (linkId: string) => directory.client.getIdentity(linkId);

test("retiring a removed person's links revokes their tokens and keeps the rows", async () => {
  const userId = await user();
  const credential = await vault.create({
    kind: "connector",
    provider: "github-user-token",
    keyId: randomUUID(),
    metadata: {},
    plaintext: "x",
  });
  createdCredentials.push(credential.id);
  let linkId = "";
  linkId = await insertLink({
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
    payload: {
      actor: ADMIN,
      owner: userId,
      provider: "github",
      reason: "person_removed",
      credentialRevoked: true,
    },
  });
  expect(audit.rows[0]?.actorUserId).toBeUndefined();
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
  const userId = await user();
  let linkId = "";
  const subject = `U-${randomUUID()}`;
  linkId = await insertLink({
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
    payload: {
      actor: ADMIN,
      owner: userId,
      provider: "slack",
      reason: "person_removed",
      credentialRevoked: false,
    },
  });
  const payload = JSON.stringify(audit.rows[0]?.payload);
  expect(payload).not.toContain(subject);
  expect(payload).not.toContain(realm);
});

test("a credential revoked before the removal is not reported as revoked by it", async () => {
  const userId = await user();
  const credential = await vault.create({
    kind: "connector",
    provider: "github-user-token",
    keyId: randomUUID(),
    metadata: {},
    plaintext: "x",
  });
  createdCredentials.push(credential.id);
  await vault.revoke(credential.id);
  let linkId = "";
  linkId = await insertLink({
    provider: "github",
    realm,
    subject: randomUUID(),
    userId,
    verifiedBy: "oauth",
    credentialId: credential.id,
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

  expect((await statusOf(linkId))?.credentialId).toBeNull();
  expect(audit.rows[0]?.payload).toMatchObject({ credentialRevoked: false });
});

test("a directory remover is recorded in the payload only, never as the acting user", async () => {
  const userId = await user();
  await insertLink({
    provider: "slack",
    realm,
    subject: randomUUID(),
    userId,
    verifiedBy: "challenge",
    status: "active",
  });
  const audit = recorder();

  await retireIdentityLinks(
    database,
    vault,
    () => audit.store,
    userId,
    "scim:directory",
  );

  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0]?.actorUserId).toBeUndefined();
  expect(audit.rows[0]?.payload).toMatchObject({
    actor: "scim:directory",
    owner: userId,
  });
});

test("an audit row that fails to write rolls the retirement back, so a retry retires and audits every link", async () => {
  const userId = await user();
  const linkIds: string[] = [];
  for (const id of [randomUUID(), randomUUID()])
    linkIds.push(
      await insertLink({
        provider: "slack",
        realm: `${realm}-${id}`,
        subject: randomUUID(),
        userId,
        verifiedBy: "challenge",
        status: "active",
      }),
    );
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

test("the audit trail's own store writes the rows inside the retirement's own transaction", async () => {
  const userId = await user();
  let linkId = "";
  linkId = await insertLink({
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

  // The store writes the row to the outbox inside the retirement's transaction; once that commits,
  // the drainer carries it to the trail in Intelligence, where it is read.
  const rows = await auditRows({ targetId: linkId });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.eventType).toBe("identity.link_retired");
});

test("a pending challenge cannot be redeemed after the person is removed", async () => {
  const userId = await user();
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
  const userId = await user();
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
  // Callers log String(error), which must name both causes.
  expect(String(error)).toContain("plugins");
  expect(String(error)).toContain("identities");
});

test("both succeeding counts both", async () => {
  expect(
    await retireOwnedAccounts({
      plugins: async () => ({ retired: 2 }),
      identities: async () => 3,
    }),
  ).toEqual({ retired: 5 });
});
