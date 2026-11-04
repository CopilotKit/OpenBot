import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { createPluginStore, type PluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";
import {
  changeServer,
  purgeSecrets,
  recordingCredentialStore,
  removeServers,
  seedCredential,
  storedServer,
  useTestVault,
} from "./support/vault";

/**
 * The whole path an administrator's request actually takes, with nothing stubbed between the request
 * and the row.
 *
 * The two halves are covered on their own: the store's refusals against a real database, and the
 * route's mapping of them against a stubbed store. Both passing does not prove the pair is wired
 * together, and the failure that would live in the gap is quiet in exactly the way that matters: a
 * refusal that reaches the browser as a 500 reads as a broken deployment rather than a correctable
 * mistake, and a refusal that stops short of the write leaves an app pointing at a credential the
 * next refresh spends. So this asks the question end to end and then looks at what Intelligence holds.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

/**
 * What the store asked of the vault. Drive's tool list is in this deployment's own code, so the
 * curated add path reaches no vault at all: no read, no write. Recorded rather than absent, so a call
 * that starts reaching one is named.
 */
const vaultCalls: string[] = [];
let store: PluginStore;

const ADMIN = {
  id: "admin-1",
  email: "admin@openbot.test",
  name: "An Administrator",
  image: null,
};

function request(
  body: unknown,
  role: "admin" | "user" = "admin",
  path = "/api/plugins/servers",
) {
  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [role] },
    // Positions 4-14 are the other stores; the real one is 15, pluginStore.
    ...(Array.from({ length: 11 }) as never[]),
    store as never,
  );

  return app.request(`http://openbot.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const serverId = "google-drive";
const suffix = randomUUID().slice(0, 8);
let personalCredentialId: string;
const customServerId = `route-custom-${suffix}`;
let foreignCredentialId: string;
let ownCredentialId: string;

/** What this deployment already had, so a database somebody is using is left as it was found. */
let existing: { credentialId: string | null } | null = null;

beforeAll(async () => {
  await useTestVault();
  const recorded = await recordingCredentialStore({
    calls: vaultCalls,
    created: [],
  });
  store = createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: {
      ...recorded,
      reveal: async (id, accessor) => {
        vaultCalls.push(`reveal:${id}`);
        return recorded.reveal(id, accessor);
      },
    },
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  });

  const app = await storedServer(serverId);
  existing = app ? { credentialId: app.credentialId } : null;

  personalCredentialId = (
    await seedCredential({
      kind: "mcp_user_token",
      provider: serverId,
      keyId: `user_someone_else_${suffix}`,
      plaintext: "not-read-here",
    })
  ).id;
  foreignCredentialId = (
    await seedCredential({
      kind: "mcp",
      // Minted for a different server, which is what makes it somebody else's to spend.
      provider: `route-elsewhere-${suffix}`,
      keyId: `mcp-elsewhere-${suffix}`,
      plaintext: "not-read-here",
    })
  ).id;
  ownCredentialId = (
    await seedCredential({
      kind: "mcp",
      provider: customServerId,
      keyId: `mcp-${customServerId}`,
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
  await removeServers([customServerId]);
  await purgeSecrets([
    personalCredentialId,
    foreignCredentialId,
    ownCredentialId,
  ]);
});

async function serverRow() {
  const app = await storedServer(serverId);
  return app ? { credentialId: app.credentialId } : null;
}

describe("adding a curated server over HTTP", () => {
  test("a credential of the wrong kind is refused, and nothing is written", async () => {
    const before = await serverRow();

    const response = await request({
      key: serverId,
      credentialId: personalCredentialId,
    });

    // Not a 500. An administrator who picked the wrong row is told what to do about it.
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(
      "takes no credential when it is added",
    );

    // And the refusal stopped the write rather than reporting on it.
    expect(await serverRow()).toEqual(before);
  });

  test("a malformed credential id is refused the same way, not as a database error", async () => {
    const response = await request({ key: serverId, credentialId: "nonsense" });

    expect(response.status).toBe(400);
  });

  test("the add the admin screen makes still works and writes the row", async () => {
    const response = await request({ key: serverId });

    expect(response.status).toBe(200);
    expect((await response.json()).server.id).toBe(serverId);
    // Whatever the pointer held before, not null: an add that names no credential leaves a registered
    // OAuth client alone, so asserting null here would pass on a fresh database and fail on the one
    // deployment shape that behaviour exists for.
    expect(await serverRow()).toEqual({
      credentialId: existing?.credentialId ?? null,
    });
    // Drive's tool list is this deployment's own: nothing in the curated add path reached the vault.
    expect(vaultCalls).toEqual([]);
  });

  test("somebody who is not an administrator is refused before the store", async () => {
    const response = await request({ key: serverId }, "user");

    expect(response.status).toBe(403);
  });
});

/**
 * The same two rules, asked over HTTP against the real store.
 *
 * Both are refusals an administrator has to be able to act on, so what they must never be is a 500:
 * "something went wrong" sends somebody to look at the deployment when the answer is to pick a
 * different token or remove the server first.
 */
describe("adding a server by URL over HTTP", () => {
  const custom = "/api/plugins/servers/custom";

  test("another server's token is refused rather than spent", async () => {
    const response = await request(
      {
        id: customServerId,
        title: "Collector",
        url: "https://collector.attacker.example/mcp",
        credentialId: foreignCredentialId,
      },
      "admin",
      custom,
    );

    expect(response.status).toBe(400);

    expect(await storedServer(customServerId)).toBeNull();
  });

  test("re-addressing a server that holds a token is refused", async () => {
    const added = await request(
      {
        id: customServerId,
        title: "Collector",
        url: "https://legit.vendor.example/mcp",
        credentialId: ownCredentialId,
      },
      "admin",
      custom,
    );
    expect(added.status).toBe(200);

    const moved = await request(
      {
        id: customServerId,
        title: "Collector",
        url: "https://collector.attacker.example/mcp",
        credentialId: ownCredentialId,
      },
      "admin",
      custom,
    );
    expect(moved.status).toBe(400);

    expect((await storedServer(customServerId))?.url).toBe(
      "https://legit.vendor.example/mcp",
    );
  });
});

afterAll(async () => {
  await database.$client.close();
});
