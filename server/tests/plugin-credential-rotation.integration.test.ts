import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { createPluginStore, type PluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  changeServer,
  liveSecrets,
  purgeSecrets,
  removeConnectionsWhere,
  removeServers,
  secretsNamed,
  seedServer,
  storedConnections,
  storedServer,
  storedSecret,
  useTestVault,
} from "./support/vault";

/**
 * Registering a client twice, and connecting twice, against a real vault.
 *
 * Both paths used to insert a second live credential for a key and revoke the first afterwards, on
 * a best-effort basis. The vault refuses a second live secret under a name outright, so the
 * question is no longer whether an orphan is left behind but whether the path still works at all.
 * A stubbed vault cannot answer that: the rule is Intelligence's, and only Intelligence enforces it.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };
const suite = randomUUID().slice(0, 8);
const serverId = "google-drive";
const personId = `plugin_rotation_person_${suite}`;

let store: PluginStore;

let clientBefore: string | null = null;
let serverExisted = false;

async function rowsFor(
  kind: "mcp_oauth_client" | "mcp_user_token",
  keyId: string,
) {
  return (await secretsNamed({ kind, provider: serverId, keyId })).map(
    (secret) => ({ id: secret.id, revokedAt: secret.revokedAt }),
  );
}

function live<T extends { revokedAt: Date | null }>(rows: T[]) {
  return rows.filter((row) => row.revokedAt === null);
}

beforeAll(async () => {
  const directory = await useTestVault();
  store = createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: createCredentialStore(directory),
    encryptionKey: ENCRYPTION_KEY,
    policy: () => policy,
  });

  await database
    .insert(users)
    .values({
      id: personId,
      email: `${personId}@openbot.test`,
      name: personId,
      emailVerified: false,
    })
    .onConflictDoNothing();

  const existing = await storedServer(serverId);
  serverExisted = existing !== null;
  clientBefore = existing?.credentialId ?? null;

  if (!existing) {
    await seedServer({
      id: serverId,
      title: "Google Drive",
      vendor: "Google",
      url: "https://www.googleapis.com/drive/v3",
      provenance: "first-party",
    });
  }

  // This run's own client key, so a deployment's real Drive registration is never touched.
  for (const secret of await liveSecrets({
    kind: "mcp_oauth_client",
    provider: serverId,
  })) {
    await directory.revokeSecret(secret.id);
  }
});

afterAll(async () => {
  await removeConnectionsWhere(
    (connection) =>
      connection.kind === "grant" &&
      connection.serverId === serverId &&
      connection.userId === personId,
  );
  /*
   * The pointer is dropped before the secrets are, and put back only if what it named survives: on
   * a project where an earlier run of this file left the pointer on one of its own secrets,
   * restoring first would put it straight back onto a secret about to be purged.
   */
  if (await storedServer(serverId)) {
    await changeServer(serverId, { credentialId: null });
  }
  const mine = [
    ...(await rowsFor("mcp_user_token", personId)),
    ...(await rowsFor("mcp_oauth_client", `oauth-client-${serverId}`)),
  ]
    .map((row) => row.id)
    .filter((id) => id !== clientBefore);
  await purgeSecrets(mine);
  await database.delete(users).where(eq(users.id, personId));
  if (clientBefore && (await storedSecret(clientBefore))) {
    await changeServer(serverId, { credentialId: clientBefore });
  }
  if (!serverExisted) {
    await removeServers([serverId]);
  }
  await database.$client.end();
});

describe("registering an OAuth client twice", () => {
  test("replaces the client rather than meeting the vault's one-live-secret rule", async () => {
    await store.registerOAuthClient({
      serverId,
      client: { clientId: `client-one-${suite}`, clientSecret: "one" },
      by: personId,
    });
    const first = live(
      await rowsFor("mcp_oauth_client", `oauth-client-${serverId}`),
    );
    expect(first).toHaveLength(1);

    await store.registerOAuthClient({
      serverId,
      client: { clientId: `client-two-${suite}`, clientSecret: "two" },
      by: personId,
    });

    const all = await rowsFor("mcp_oauth_client", `oauth-client-${serverId}`);
    expect(live(all)).toHaveLength(1);
    expect(live(all)[0]?.id).not.toBe(first[0]?.id);
    expect(all.filter((row) => row.revokedAt !== null).length).toBeGreaterThan(
      0,
    );

    expect((await storedServer(serverId))?.credentialId).toBe(
      live(all)[0]?.id as string,
    );
  });
});

describe("reconnecting the same person to the same server", () => {
  test("replaces their token rather than meeting the vault's one-live-secret rule", async () => {
    await store.recordConnection({
      serverId,
      userId: personId,
      refreshToken: "refresh-one",
      scope: "https://www.googleapis.com/auth/drive.readonly",
    });
    const first = live(await rowsFor("mcp_user_token", personId));
    expect(first).toHaveLength(1);

    await store.recordConnection({
      serverId,
      userId: personId,
      refreshToken: "refresh-two",
      scope: "https://www.googleapis.com/auth/drive.readonly",
    });

    const all = await rowsFor("mcp_user_token", personId);
    expect(live(all)).toHaveLength(1);
    expect(live(all)[0]?.id).not.toBe(first[0]?.id);

    const connection = (await storedConnections()).grants.find(
      (grant) => grant.serverId === serverId && grant.userId === personId,
    );
    expect(connection?.credentialId).toBe(live(all)[0]?.id as string);
  });
});
