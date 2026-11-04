import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { count, eq } from "drizzle-orm";
import postgres from "postgres";
import { encryptSecret } from "../src/credentials";
import { applyMigrations } from "../src/db/apply-migrations";
import { createDatabase, type Database } from "../src/db/client";
import {
  brokeredConnections,
  brokeredIdentities,
  credentials,
  intelligenceCopies,
  mcpServers,
  mcpUserCredentials,
  savedLogins,
  users,
} from "../src/db/schema";
import { createVaultClient } from "../src/vault/client";
import {
  type ConnectionsDirectory,
  createConnectionsDirectory,
} from "../src/vault/directory";
import { brokeredId, grantId, identityId } from "../src/vault/ids";
import {
  copyLocalVaultToIntelligence,
  VaultCopyMismatchError,
} from "../src/vault/upgrade";
import { testIntelligence } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

// Moving an existing deployment's vault, apps and connections into Intelligence at boot
// (vault/upgrade.ts), from a database written the way the previous release wrote it: credentials and
// saved logins encrypted under the local KEY_ENCRYPTION_KEY, apps in mcp_servers, connections in their
// three tables. Each deployment is a fresh database with every migration applied.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const server = new URL(testDatabaseUrl());
const administrative = new URL(server.href);
administrative.pathname = "/postgres";
const suite = randomUUID().slice(0, 8);
const migrations = join(import.meta.dir, "..", "drizzle");
const created: string[] = [];
const opened: Database[] = [];
const replicas: ConnectionsDirectory[] = [];
const cleanup: Array<() => Promise<void>> = [];

async function freshDeployment(): Promise<Database> {
  const name = `openbot_vault_copy_${suite}_${created.length}`;
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  created.push(name);
  const url = new URL(server.href);
  url.pathname = `/${name}`;
  const client = postgres(url.href, { max: 1, onnotice: () => {} });
  try {
    await applyMigrations(client, migrations);
  } finally {
    await client.end({ timeout: 5 });
  }
  const database = createDatabase(url.href, TEST_POOL);
  opened.push(database);
  return database;
}

async function replica(): Promise<ConnectionsDirectory> {
  const directory = createConnectionsDirectory({
    client: createVaultClient(testIntelligence()),
  });
  await directory.start();
  replicas.push(directory);
  return directory;
}

afterEach(async () => {
  for (const work of cleanup.splice(0)) await work();
  for (const directory of replicas.splice(0)) directory.stop();
  for (const database of opened.splice(0)) await database.$client.close();
});

afterAll(async () => {
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    for (const name of created)
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}, 60_000);

/** A deployment's vault, apps and connections as the release before this one wrote them. */
async function legacyVault(database: Database) {
  const tag = randomUUID().slice(0, 8);
  const person = `copy-person-${tag}`;
  await database
    .insert(users)
    .values({ id: person, email: `${person}@example.test`, name: "Person" });
  const ids = {
    modelKey: randomUUID(),
    retiredKey: randomUUID(),
    agentKey: randomUUID(),
    oauthClient: randomUUID(),
    userToken: randomUUID(),
    login: `login-${tag}`,
    server: `copy-app-${tag}`,
    brokeredApp: `copy-gmail-${tag}`,
  };
  const at = new Date("2026-10-01T12:00:00.000Z");
  await database.insert(credentials).values([
    {
      id: ids.retiredKey,
      kind: "model",
      provider: "openai",
      keyId: `ref-${tag}`,
      metadata: {},
      encryptedValue: await encryptSecret(KEY, "sk-retired"),
      revokedAt: new Date("2026-10-02T00:00:00.000Z"),
      createdAt: at,
    },
    {
      id: ids.modelKey,
      kind: "model",
      provider: "openai",
      keyId: `ref-${tag}`,
      metadata: {},
      encryptedValue: await encryptSecret(KEY, "sk-live"),
      createdAt: new Date("2026-10-03T00:00:00.000Z"),
    },
    {
      // A remote Bot's key: the agent registry names it as `auth.credentialRef`.
      id: ids.agentKey,
      kind: "agent",
      provider: "ag-ui",
      keyId: `bot-${tag}`,
      metadata: { header: "Authorization" },
      encryptedValue: await encryptSecret(KEY, "Bearer remote-bot-key"),
    },
    {
      id: ids.oauthClient,
      kind: "mcp_oauth_client",
      provider: ids.server,
      keyId: `oauth-client-${ids.server}`,
      metadata: { server: ids.server, clientId: "client-1" },
      encryptedValue: await encryptSecret(
        KEY,
        JSON.stringify({ clientId: "client-1", clientSecret: "shh" }),
      ),
    },
    {
      id: ids.userToken,
      kind: "mcp_user_token",
      provider: ids.server,
      keyId: person,
      metadata: { server: ids.server, scope: "read" },
      encryptedValue: await encryptSecret(KEY, "refresh-token-1"),
    },
  ]);
  await database.insert(savedLogins).values({
    id: ids.login,
    ownerUserId: person,
    origin: "https://example.com",
    username: "ada",
    encryptedPassword: await encryptSecret(KEY, "hunter2"),
    lastUsedAt: at,
  });
  await database.insert(mcpServers).values([
    {
      id: ids.server,
      title: "Copied App",
      vendor: "example",
      url: "https://mcp.example.com/mcp",
      credentialId: ids.oauthClient,
      addedBy: person,
      createdAt: at,
    },
    {
      id: ids.brokeredApp,
      title: "Gmail",
      vendor: "composio",
      url: `composio://${ids.brokeredApp}`,
      provenance: "composio",
      authScheme: "OAUTH2",
      accountMode: "personal",
    },
  ]);
  await database.insert(mcpUserCredentials).values({
    serverId: ids.server,
    userId: person,
    credentialId: ids.userToken,
    scope: "read",
  });
  await database.insert(brokeredConnections).values({
    provider: "composio",
    app: ids.brokeredApp,
    holder: "person",
    userId: person,
    vendorUserId: person,
    verified: true,
    verifiedAt: at,
  });
  await database.insert(brokeredIdentities).values({
    provider: "composio",
    userId: person,
    vendorUserId: `${person}:filed`,
  });
  cleanup.push(async () => {
    const directory = await replica();
    for (const id of [ids.server, ids.brokeredApp])
      if (await directory.findServer(id)) await directory.removeServer(id);
    for (const id of [
      brokeredId("composio", ids.brokeredApp, "person", person),
      identityId("composio", person),
    ])
      await directory.removeConnection(id);
    for (const id of [
      ids.modelKey,
      ids.retiredKey,
      ids.agentKey,
      ids.oauthClient,
      ids.userToken,
      ids.login,
    ])
      await directory.purgeSecret(id);
  });
  return { ...ids, person };
}

async function tableCounts(database: Database) {
  const [c] = await database.select({ n: count() }).from(credentials);
  const [l] = await database.select({ n: count() }).from(savedLogins);
  const [s] = await database.select({ n: count() }).from(mcpServers);
  const [g] = await database.select({ n: count() }).from(mcpUserCredentials);
  const [b] = await database.select({ n: count() }).from(brokeredConnections);
  const [i] = await database.select({ n: count() }).from(brokeredIdentities);
  return [c?.n, l?.n, s?.n, g?.n, b?.n, i?.n];
}

describe("copying an existing deployment's vault, apps and connections into Intelligence", () => {
  test("every secret crosses under the same id, decrypted with the local key, revoked ones included; apps and connections follow; the copy is recorded", async () => {
    const database = await freshDeployment();
    const ids = await legacyVault(database);
    const before = await tableCounts(database);
    const directory = await replica();

    const outcome = await copyLocalVaultToIntelligence(
      database,
      directory,
      KEY,
    );
    expect(outcome.secrets).toMatchObject({ kind: "copied", local: 6 });
    expect(outcome.connections).toMatchObject({
      kind: "copied",
      servers: 2,
      connections: 3,
    });

    const client = directory.client;
    const reveal = async (id: string) =>
      (await client.secrets.reveal(id, { purpose: "upgrade_test" })).value;
    expect(await reveal(ids.modelKey)).toBe("sk-live");
    expect(await reveal(ids.agentKey)).toBe("Bearer remote-bot-key");
    expect(await reveal(ids.userToken)).toBe("refresh-token-1");
    expect(JSON.parse(await reveal(ids.oauthClient))).toEqual({
      clientId: "client-1",
      clientSecret: "shh",
    });
    expect(await reveal(ids.login)).toBe("hunter2");

    const retired = await client.secrets.get(ids.retiredKey);
    expect(retired?.revokedAt).not.toBeNull();
    const token = await client.secrets.get(ids.userToken);
    expect(token).toMatchObject({
      kind: "mcp_user_token",
      provider: ids.server,
      keyId: ids.person,
      ownerUserId: ids.person,
      metadata: { server: ids.server, scope: "read" },
    });
    const login = await client.secrets.get(ids.login);
    expect(login).toMatchObject({
      kind: "website_login",
      provider: "https://example.com",
      keyId: "ada",
      ownerUserId: ids.person,
      metadata: { lastUsedAt: "2026-10-01T12:00:00.000Z" },
    });

    const app = await client.toolServers.get(ids.server);
    expect(app).toMatchObject({
      title: "Copied App",
      url: "https://mcp.example.com/mcp",
      credentialId: ids.oauthClient,
      addedBy: ids.person,
    });
    expect(app?.createdAt.toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(
      await client.connections.get(grantId(ids.server, ids.person)),
    ).toMatchObject({
      kind: "grant",
      credentialId: ids.userToken,
      scope: "read",
    });
    expect(
      await client.connections.get(
        brokeredId("composio", ids.brokeredApp, "person", ids.person),
      ),
    ).toMatchObject({
      kind: "brokered",
      verified: true,
      vendorUserId: ids.person,
    });
    expect(
      await client.connections.get(identityId("composio", ids.person)),
    ).toMatchObject({ kind: "identity", vendorUserId: `${ids.person}:filed` });

    const recorded = await database
      .select()
      .from(intelligenceCopies)
      .where(eq(intelligenceCopies.name, "vault"));
    expect(recorded).toHaveLength(1);
    // The local tables are read, never written: they stay for one release exactly as they were.
    expect(await tableCounts(database)).toEqual(before);
  }, 60_000);

  test("a second boot copies nothing, and a secret purged since is not brought back", async () => {
    const database = await freshDeployment();
    const ids = await legacyVault(database);
    const directory = await replica();
    await copyLocalVaultToIntelligence(database, directory, KEY);
    await directory.purgeSecret(ids.agentKey);

    const again = await copyLocalVaultToIntelligence(database, directory, KEY);
    expect(again).toEqual({
      secrets: { kind: "done-before" },
      connections: { kind: "done-before" },
    });
    expect(await directory.client.secrets.get(ids.agentKey)).toBeNull();
  }, 60_000);

  test("two replicas copying at once both finish, and each record exists once", async () => {
    const database = await freshDeployment();
    const ids = await legacyVault(database);
    const [first, second] = [await replica(), await replica()];
    const outcomes = await Promise.all([
      copyLocalVaultToIntelligence(database, first, KEY),
      copyLocalVaultToIntelligence(database, second, KEY),
    ]);
    // One copied; the other waited its turn and found the copy recorded.
    expect(outcomes.map((outcome) => outcome.secrets.kind).sort()).toEqual([
      "copied",
      "done-before",
    ]);
    const { secrets } = await first.client.secrets.all({
      includeRevoked: true,
      provider: "openai",
      keyId: `ref-${ids.person.slice("copy-person-".length)}`,
    });
    expect(secrets.map((secret) => secret.id).sort()).toEqual(
      [ids.modelKey, ids.retiredKey].sort(),
    );
  }, 60_000);

  test("every app id the previous release could mint, at its widest, crosses whole with its connections", async () => {
    const database = await freshDeployment();
    const person = `copy-wide-${suite}`;
    await database
      .insert(users)
      .values({ id: person, email: `${person}@example.test`, name: "Wide" });
    /*
     * The widest of each path that ever wrote mcp_servers. Added by address: `^[a-z0-9][a-z0-9-]{0,38}
     * [a-z0-9]$` since the first release, so 40 characters. Brokered: `composio-` or `arcade-` before
     * the vendor's own `[A-Za-z0-9_-]+` slug, whose length nothing here ever bounded, so one at the
     * 1024 characters Intelligence takes. Catalogue keys are a fixed set, all shorter.
     */
    const byAddress = `a${suite}${"-0".repeat(15)}z`;
    const slug = `Google_Calendar-v2_${suite}_`.padEnd(
      1024 - "composio-".length,
      "x",
    );
    const brokered = `composio-${slug}`;
    const arcade = `arcade-Google_Calendar_${suite}`;
    expect(byAddress).toMatch(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/);
    expect(byAddress).toHaveLength(40);
    expect(brokered).toHaveLength(1024);
    const token = randomUUID();
    await database.insert(credentials).values({
      id: token,
      kind: "mcp_user_token",
      provider: byAddress,
      keyId: person,
      metadata: { server: byAddress, scope: "read" },
      encryptedValue: await encryptSecret(KEY, "wide-token"),
    });
    await database.insert(mcpServers).values([
      {
        id: byAddress,
        // Typed by an administrator, and never bounded.
        title: `Wide app ${"t".repeat(5000)}`,
        vendor: "mcp.example.com",
        url: `https://mcp.example.com/${"p".repeat(5000)}`,
        entraScope: `api://${"s".repeat(2000)}/.default`,
        addedBy: person,
      },
      {
        id: brokered,
        title: "Google Calendar",
        // Composio may publish an empty logo, and the release before this one stored it.
        logo: "",
        vendor: "composio",
        url: `composio://${slug}`,
        provenance: "composio",
        authScheme: "OAUTH2",
        accountMode: "personal",
      },
      {
        id: arcade,
        title: "Google Calendar",
        vendor: "arcade",
        url: `arcade://Google_Calendar_${suite}`,
        provenance: "arcade",
        accountMode: "personal",
      },
    ]);
    await database.insert(mcpUserCredentials).values({
      serverId: byAddress,
      userId: person,
      credentialId: token,
      scope: "read",
    });
    await database.insert(brokeredConnections).values({
      provider: "composio",
      app: slug,
      holder: "person",
      userId: person,
      vendorUserId: person,
    });
    const directory = await replica();
    cleanup.push(async () => {
      const after = await replica();
      for (const id of [byAddress, brokered, arcade])
        if (await after.findServer(id)) await after.removeServer(id);
      await after.removeConnection(
        brokeredId("composio", slug, "person", person),
      );
      await after.purgeSecret(token);
    });

    const outcome = await copyLocalVaultToIntelligence(
      database,
      directory,
      KEY,
    );
    expect(outcome.connections).toMatchObject({
      kind: "copied",
      servers: 3,
      connections: 2,
    });
    const client = directory.client;
    for (const id of [byAddress, brokered, arcade])
      expect((await client.toolServers.get(id))?.id).toBe(id);
    expect((await client.toolServers.get(brokered))?.logo).toBe("");
    expect((await client.toolServers.get(byAddress))?.title).toHaveLength(
      "Wide app ".length + 5000,
    );
    expect(
      await client.connections.get(grantId(byAddress, person)),
    ).toMatchObject({ kind: "grant", credentialId: token });
    expect(
      await client.connections.get(
        brokeredId("composio", slug, "person", person),
      ),
    ).toMatchObject({ kind: "brokered", app: slug });
  }, 60_000);

  test("a secret the local key cannot decrypt stops the boot, names it, and records nothing", async () => {
    const database = await freshDeployment();
    const broken = randomUUID();
    await database.insert(credentials).values({
      id: broken,
      kind: "connector",
      provider: "search",
      keyId: `broken-${broken}`,
      metadata: {},
      encryptedValue: await encryptSecret(
        "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
        "written under another key",
      ),
    });
    const directory = await replica();
    const copy = copyLocalVaultToIntelligence(database, directory, KEY);
    await expect(copy).rejects.toBeInstanceOf(VaultCopyMismatchError);
    await expect(copy).rejects.toThrow(broken);
    const recorded = await database.select().from(intelligenceCopies);
    expect(recorded.map((row) => row.name)).not.toContain("vault");
  }, 60_000);
});
