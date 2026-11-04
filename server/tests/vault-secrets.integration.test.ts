import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { count } from "drizzle-orm";
import {
  agentAuthHeaders,
  retireReplacedKey,
  storeAgentAuth,
} from "../src/agents/auth-header";
import { createAuditStore } from "../src/audit";
import {
  CredentialUnusableError,
  createCredentialAdminService,
  createCredentialStore,
  resolveModelApiKey,
} from "../src/credentials";
import { createDatabase, type Database } from "../src/db/client";
import { credentials, savedLogins, users } from "../src/db/schema";
import { createPasswordStore } from "../src/passwords/store";
import type { ConnectionsDirectory } from "../src/vault/directory";
import { holdSecretLease } from "../src/vault/leases";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { anotherReplica, purgeSecrets, useTestVault } from "./support/vault";

// The vault as OpenBot uses it, against a real Intelligence: every credential and saved login is a
// secret there, never a row here; every read of a value is recorded with who and which Bot; a change
// made on one replica reaches another's memory; and the reference a remote Bot's registry entry
// holds keeps resolving.

let database: Database;
let directory: ConnectionsDirectory;
const replicas: ConnectionsDirectory[] = [];
const created: string[] = [];

beforeAll(async () => {
  database = createDatabase(testDatabaseUrl(), TEST_POOL);
  directory = await useTestVault();
});

afterAll(async () => {
  for (const replica of replicas) replica.stop();
  await purgeSecrets(created);
  await database.$client.close();
});

async function localCredentialRows() {
  const [row] = await database.select({ n: count() }).from(credentials);
  return row?.n ?? 0;
}

describe("credentials in Intelligence's vault", () => {
  test("a credential is stored, rotated and revoked in the vault, and nothing is written here", async () => {
    const before = await localCredentialRows();
    const store = createCredentialStore(directory);
    const admin = createCredentialAdminService(
      store,
      createAuditStore(database),
    );
    const keyId = `vault-test-${randomUUID()}`;
    const first = await admin.create({
      kind: "model",
      provider: "openai",
      keyId,
      metadata: {},
      plaintext: "sk-first",
      actorUserId: "admin",
    });
    created.push(first.id);
    // A second key for the same name is a rotation: the vault revokes the first in the same step.
    const second = await admin.create({
      kind: "model",
      provider: "openai",
      keyId,
      metadata: {},
      plaintext: "sk-second",
      actorUserId: "admin",
    });
    created.push(second.id);
    expect(second.id).not.toBe(first.id);
    const listed = (await admin.list()).filter((c) => c.keyId === keyId);
    expect(listed.map((c) => [c.id, c.revokedAt !== null])).toEqual([
      [first.id, true],
      [second.id, false],
    ]);
    // Never a value in what the admin page lists.
    expect(JSON.stringify(listed)).not.toContain("sk-");

    const reader = { purpose: "model_run", userId: "person-1", botId: "bot-1" };
    expect(
      await resolveModelApiKey({
        reader: store,
        provider: "openai",
        keyId,
        environment: {},
        accessor: reader,
      }),
    ).toBe("sk-second");
    await admin.revoke(second.id, "admin");
    await expect(store.reveal(second.id, reader)).rejects.toBeInstanceOf(
      CredentialUnusableError,
    );

    // Every read went to the vault's record, with the person and the Bot.
    const trail = await directory.client.secrets.accessEvents(second.id);
    expect(trail.map((event) => event.outcome)).toContain("revealed");
    expect(trail.find((event) => event.outcome === "revealed")).toMatchObject({
      accessorUserId: "person-1",
      accessorAgentId: "bot-1",
      purpose: "model_run",
    });
    expect(await localCredentialRows()).toBe(before);
  });

  test("a secret revoked on one replica stops being spent on another, whose memory held its value", async () => {
    const other = await anotherReplica();
    replicas.push(other);
    const here = createCredentialStore(directory);
    const there = createCredentialStore(other);
    const stored = await here.create({
      kind: "mcp",
      provider: `server-${randomUUID()}`,
      keyId: "token",
      metadata: {},
      plaintext: "mcp-token",
    });
    created.push(stored.id);
    const reader = { purpose: "mcp_tool_call", userId: "person-2" };
    expect((await there.reveal(stored.id, reader)).value).toBe("mcp-token");

    await here.revoke(stored.id);
    // The other replica hears of it over the realtime gateway and drops what it held.
    const deadline = Date.now() + 10_000;
    let refused = false;
    while (!refused && Date.now() < deadline) {
      try {
        await there.reveal(stored.id, reader);
        await Bun.sleep(100);
      } catch (error) {
        refused = error instanceof CredentialUnusableError;
        if (!refused) throw error;
      }
    }
    expect(refused).toBe(true);
  });

  test("a remote Bot's key keeps resolving by the reference its registry entry holds, and a replaced key stops", async () => {
    const store = createCredentialStore(directory);
    const botId = `vault-bot-${randomUUID()}`;
    const auth = await storeAgentAuth({
      store,
      agentId: botId,
      header: "Authorization",
      value: "Bearer first",
    });
    created.push(auth.credentialId);
    expect(
      await agentAuthHeaders({
        reader: store,
        auth,
        botId,
        userId: "person-3",
      }),
    ).toEqual({ Authorization: "Bearer first" });

    const replaced = await storeAgentAuth({
      store,
      agentId: botId,
      header: "Authorization",
      value: "Bearer second",
      previousCredentialId: auth.credentialId,
    });
    created.push(replaced.credentialId);
    await retireReplacedKey(store, { auth }, { auth: replaced });
    expect(
      await agentAuthHeaders({
        reader: store,
        auth,
        botId,
        userId: "person-3",
      }),
    ).toBeUndefined();
    expect(
      await agentAuthHeaders({
        reader: store,
        auth: replaced,
        botId,
        userId: "person-3",
      }),
    ).toEqual({ Authorization: "Bearer second" });
  });
});

describe("saved website logins in Intelligence's vault", () => {
  test("a login is saved, listed without its password, typed for one Bot (recorded), and deleted for good", async () => {
    const owner = `login-owner-${randomUUID()}`;
    await database
      .insert(users)
      .values({ id: owner, email: `${owner}@example.test`, name: "Owner" });
    const store = createPasswordStore(database);
    const [rowsBefore] = await database
      .select({ n: count() })
      .from(savedLogins);

    const saved = await store.saveLogin({
      ownerUserId: owner,
      origin: "https://shop.example.com",
      username: "ada",
      password: "first-password",
    });
    created.push(saved.id);
    // Saving the same login again replaces its password and keeps its id.
    const again = await store.saveLogin({
      ownerUserId: owner,
      origin: "https://shop.example.com",
      username: "ada",
      password: "second-password",
    });
    expect(again.id).toBe(saved.id);

    const listed = await store.logins(owner);
    expect(listed.map((login) => [login.origin, login.username])).toEqual([
      ["https://shop.example.com", "ada"],
    ]);
    expect(JSON.stringify(listed)).not.toContain("password");
    // Another person never sees it.
    expect(await store.logins(`someone-else-${randomUUID()}`)).toEqual([]);
    expect(await store.revealPassword("someone-else", saved.id, "bot-x")).toBe(
      null,
    );

    expect(await store.revealPassword(owner, saved.id, "bot-shop")).toBe(
      "second-password",
    );
    await store.touchLogin(owner, saved.id);
    expect((await store.login(owner, saved.id))?.lastUsedAt).not.toBeNull();
    const trail = await directory.client.secrets.accessEvents(saved.id);
    expect(trail[0]).toMatchObject({
      outcome: "revealed",
      accessorUserId: owner,
      accessorAgentId: "bot-shop",
      purpose: "website_sign_in",
    });

    expect(await store.deleteLogin(owner, saved.id)).toBe(true);
    expect(await directory.client.secrets.get(saved.id)).toBeNull();
    const [rowsAfter] = await database.select({ n: count() }).from(savedLogins);
    expect(rowsAfter?.n).toBe(rowsBefore?.n);
  });
});

describe("one holder at a time for a secret, across replicas", () => {
  test("two holders take turns, and the second learns the version the first wrote", async () => {
    const key = `lease-test-${randomUUID()}`;
    const order: string[] = [];
    const first = await holdSecretLease(database, key);
    expect(first.version).toBeNull();
    const second = holdSecretLease(database, key).then(async (lease) => {
      order.push("second took it");
      expect(lease.version).toBe(7);
      await lease.release();
    });
    await Bun.sleep(300);
    order.push("first released");
    await first.release(7);
    await second;
    expect(order).toEqual(["first released", "second took it"]);
  });

  test("a holder that died lets go when its lease expires", async () => {
    const key = `lease-expiry-${randomUUID()}`;
    await holdSecretLease(database, key, { ttlMs: 200 });
    const started = Date.now();
    const next = await holdSecretLease(database, key, { waitMs: 5_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    await next.release();
  });
});
