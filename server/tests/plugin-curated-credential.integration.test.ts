import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { CATALOGUE, serverCredentialKind } from "../src/plugins/catalogue";
import {
  CustomServerRefusedError,
  createPluginStore,
  type PluginStore,
} from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  changeServer,
  purgeSecrets,
  removeServers,
  seedCredential,
  storedServer,
  useTestVault,
} from "./support/vault";

/**
 * Which credential a curated server is allowed to be pointed at.
 *
 * `addCustomServer` was given this rule and `addServer`, one function above it, was not: it takes the
 * same `credentialId` from the same administrator's request and stored it unread. The two paths are
 * a pair, and a guard on one of them is a guard on the path somebody happened to look at.
 *
 * What is reachable today is narrower than the custom case and worth stating rather than dressing
 * up. The one entry in the catalogue is `user-oauth`, whose client is registered through
 * `registerOAuthClient` and sent to a pinned vendor address. What is left is a credential of the
 * wrong kind being accepted and spent, a malformed id arriving as a database error where a refusal
 * belongs, and the whole hole reopening the moment a fork re-adds a `deployment-bearer` vendor,
 * which the catalogue's own comment invites.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

let store: PluginStore;

/** The catalogue key under test. Real, because which credential it takes is a property of the entry. */
const serverId = "google-drive";
const suffix = randomUUID().slice(0, 8);
let deploymentCredentialId: string;
let personalCredentialId: string;
let oauthClientCredentialId: string;

/**
 * Whether this deployment already had the server, and what it pointed at.
 *
 * The id is a real catalogue key rather than a suite-scoped one, so on a database somebody is using
 * it is their configured server. It is removed only when this suite is what created it, and left
 * pointing where it pointed before when it is not.
 */
let existing: { credentialId: string | null } | null = null;

beforeAll(async () => {
  const directory = await useTestVault();
  store = createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: createCredentialStore(directory),
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  });

  const app = await storedServer(serverId);
  existing = app ? { credentialId: app.credentialId } : null;

  deploymentCredentialId = (
    await seedCredential({
      kind: "mcp",
      provider: serverId,
      keyId: `mcp-${serverId}-${suffix}`,
      plaintext: "not-read-here",
    })
  ).id;
  oauthClientCredentialId = (
    await seedCredential({
      kind: "mcp_oauth_client",
      provider: serverId,
      keyId: `oauth-client-${serverId}-${suffix}`,
      plaintext: "not-read-here",
    })
  ).id;
  personalCredentialId = (
    await seedCredential({
      kind: "mcp_user_token",
      provider: serverId,
      // For a user token the key is the person, which is what makes one pickable by name from the
      // administrator's own credential list.
      keyId: `user_someone_else_${suffix}`,
      plaintext: "not-read-here",
    })
  ).id;
});

afterAll(async () => {
  if (existing) {
    await changeServer(serverId, { credentialId: existing.credentialId });
  } else {
    await removeServers([serverId]);
  }
  await purgeSecrets([
    deploymentCredentialId,
    oauthClientCredentialId,
    personalCredentialId,
  ]);
});

describe("a curated server may only be pointed at its own kind of credential", () => {
  test("somebody else's connector token is refused, and nothing is written", async () => {
    await expect(
      store.addServer({
        key: serverId,
        credentialId: personalCredentialId,
        by: "admin@example.com",
      }),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);

    // The refusal has to stop the write, not merely report on it: an app here is a pointer the next
    // refresh dereferences.
    const app = await storedServer(serverId);
    expect(app !== null).toBe(existing !== null);
    if (app) expect(app.credentialId).toBe(existing?.credentialId ?? null);
  });

  test("a deployment token is refused for a vendor reached as the person asking", async () => {
    // The right kind for a shared-token server and the wrong thing entirely for this one. Drive is
    // answered with each person's own grant, and the deployment's OAuth client is registered through
    // its own call, so there is no credential for this path to be given at all.
    await expect(
      store.addServer({
        key: serverId,
        credentialId: deploymentCredentialId,
        by: "admin@example.com",
      }),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);
  });

  test("a malformed credential id is a refusal rather than a database error", async () => {
    // A credential id is a uuid, so a value that is not one used to make the lookup itself fail and
    // the administrator got a 500 where a refusal belongs. The same was true of the custom path
    // before its shape check, and it is the reason that check reads the shape before the lookup.
    const refused = store
      .addServer({
        key: serverId,
        credentialId: "not-a-uuid",
        by: "admin@example.com",
      })
      .catch((error: Error) => error);
    expect(await refused).toBeInstanceOf(CustomServerRefusedError);
  });

  test("adding it again leaves the registered OAuth client where it was", async () => {
    /*
     * `registerOAuthClient` keeps the client it minted in this column, and adding the server again
     * to change an instance host says nothing about that client. Clearing it orphaned a credential
     * row that nothing revokes and told everybody who had connected that the deployment has no
     * client registered, and there is no way to hand it back through this call now that a
     * `user-oauth` entry refuses a credential id.
     */
    await store.addServer({ key: serverId, by: "admin@example.com" });
    await changeServer(serverId, { credentialId: oauthClientCredentialId });

    await store.addServer({ key: serverId, by: "admin@example.com" });

    expect((await storedServer(serverId))?.credentialId).toBe(
      oauthClientCredentialId,
    );

    // Put it back, so the case below reads the pointer this suite left rather than this one.
    await changeServer(serverId, { credentialId: null });
  });

  test("adding the server without a credential still works", async () => {
    // The case that must keep passing, so the refusals above are a rule and not a wall. This is also
    // how the admin screen adds this vendor: it sends no credential and registers the OAuth client
    // afterwards.
    const added = await store.addServer({
      key: serverId,
      by: "admin@example.com",
    });
    expect(added.id).toBe(serverId);

    expect((await storedServer(serverId))?.credentialId).toBeNull();
  });
});

/**
 * Every entry the catalogue actually holds, asked the same question.
 *
 * The shared-token branch cannot be reached today: the catalogue is frozen in code and its one entry
 * is reached as the person asking. Rather than add a seam to this store so a test can invent an
 * entry, the check is written over whatever the catalogue contains, so the branch starts being
 * exercised the moment somebody re-adds one of the vendors that were taken out. That is the review
 * where it matters, and this is the test that will be sitting there when it happens.
 */
describe("every curated entry is asked which credential it takes", () => {
  test("the catalogue's own entries decide it, whatever they are", async () => {
    expect(CATALOGUE.length).toBeGreaterThan(0);

    for (const entry of CATALOGUE) {
      const kind = serverCredentialKind(entry);

      if (kind === null) {
        // Takes none from the caller, so any id is refused, including one of the right kind.
        await expect(
          store.addServer({
            key: entry.key,
            credentialId: deploymentCredentialId,
            by: "admin@example.com",
          }),
        ).rejects.toBeInstanceOf(CustomServerRefusedError);
        continue;
      }

      // A shared-token entry takes the deployment's token for that server and nothing else. The
      // fixture credential belongs to a different server, so it is refused on ownership, which is
      // the branch a wrong pointer would take.
      await expect(
        store.addServer({
          key: entry.key,
          credentialId: deploymentCredentialId,
          by: "admin@example.com",
        }),
      ).rejects.toBeInstanceOf(CustomServerRefusedError);
    }
  });
});

afterAll(async () => {
  await database.$client.close();
});
