import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  credentials,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pluginGrants,
  users,
} from "../src/db/schema";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/**
 * Whose credential a call to a `user-oauth` server goes out with.
 *
 * Every test here is a refusal or a selection, and both matter for the same reason: this is the
 * mechanism that makes two people asking one question get the answers their own accounts can see.
 * The failure that must not exist is a call falling back to somebody else's grant, or to the
 * deployment's, when the asker has none of their own. That failure is silent by nature — it returns
 * a plausible answer built from documents the asker cannot open — so it is tested for directly
 * rather than inferred from the happy path working.
 *
 * The vendor is never reached. Every case below is decided before the network, which is itself the
 * property: a call with no grant behind it must not leave the building.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const botId = `agent_oauth_bot_${suite}`;
const askerId = `user_oauth_asker_${suite}`;
const otherId = `user_oauth_other_${suite}`;
const serverId = "google-drive";
const toolName = "search_files";
const ref = `${serverId}/${toolName}`;

// 32 zero bytes in base64. A real AES-256 key length, unlike `"x".repeat(44)`, which decodes to 33
// bytes and makes `importKey` throw — the existing plugin store test gets away with it only because
// every call there is refused before the vault is ever opened.
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

/** The refresh tokens each person's row points at, so a test can tell whose was chosen. */
const askerRefreshToken = `refresh-token-for-asker-${suite}`;
const otherRefreshToken = `refresh-token-for-other-${suite}`;

/**
 * Every token the store decrypted, in order.
 *
 * The store hands a token to the MCP client, which is the one thing this test cannot let happen for
 * real. Recording it at the vault boundary instead answers the only question that matters — whose
 * secret was about to be sent — without a vendor to send it to.
 */
const decrypted: string[] = [];

/** Every refresh token handed to the vendor's token endpoint, in order. */
const exchanged: string[] = [];

/** The deployment's OAuth client, as the connect flow will eventually write it. */
const CLIENT = { clientId: "client-id", clientSecret: "client-secret" };

/** What a minted access token looks like, so a test can tell which refresh token produced it. */
const accessTokenFrom = (refreshToken: string) => `access(${refreshToken})`;

let serverWasAlreadyConfigured = false;
/**
 * The OAuth client this deployment had before the suite ran, restored afterwards.
 *
 * `mcp_servers.credential_id` is live configuration: on a database somebody uses, it points at the
 * client an administrator registered. This suite has to repoint it to exercise the selection, and it
 * used to leave it repointed at a credential the cleanup then deleted — so the connector afterwards
 * reported "no OAuth client registered yet" and the administrator's own registration was gone.
 *
 * There is no foreign key to catch that: `mcp_servers.credential_id` is `text` against a `uuid`
 * primary key, so the database will hold a pointer to a row that does not exist.
 */
let clientBefore: string | null = null;
const credentialIds: string[] = [];

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    readSecret: async (id) => {
      const [row] = await database
        .select({
          encryptedValue: credentials.encryptedValue,
          revokedAt: credentials.revokedAt,
        })
        .from(credentials)
        .where(eq(credentials.id, id));
      return row ?? null;
    },
    // This suite writes its rows directly, so that what is under test is the selection rather than
    // the connect flow. Loud rather than absent, so a call here shows up instead of passing quietly.
    create: async () => {
      throw new Error("this suite writes credentials directly");
    },
    revoke: async () => {
      throw new Error("this suite does not revoke credentials");
    },
  },
  encryptionKey: ENCRYPTION_KEY,
  policy: () => policy,
  // Stops before the network, and records what the call would have gone out with.
  callVendor: async (connection) => {
    decrypted.push(connection.token ?? "<none>");
    return { text: "[vendor not reached in tests]", isError: false };
  },
  /*
   * Stands in for Google's token endpoint, and records whose refresh token was presented.
   *
   * This is where the security property is observable. The access token that reaches the vendor is
   * derived from the refresh token that was spent, so asserting on it proves the whole chain picked
   * one person's grant — rather than proving only that some token was sent.
   */
  exchangeRefreshToken: async ({ client, refreshToken }) => {
    expect(client).toEqual(CLIENT);
    exchanged.push(refreshToken);
    return { accessToken: accessTokenFrom(refreshToken) };
  },
});

/** Register the deployment's OAuth client, which is what `mcp_servers.credential_id` holds. */
async function registerClient() {
  const [credential] = await database
    .insert(credentials)
    .values({
      kind: "mcp_oauth_client",
      provider: serverId,
      keyId: "oauth-client",
      metadata: { clientId: CLIENT.clientId },
      encryptedValue: await encryptSecret(
        ENCRYPTION_KEY,
        JSON.stringify(CLIENT),
      ),
    })
    .returning({ id: credentials.id });
  if (!credential) throw new Error("client was not stored");
  credentialIds.push(credential.id);
  await database
    .update(mcpServers)
    .set({ credentialId: credential.id })
    .where(eq(mcpServers.id, serverId));
  return credential.id;
}

async function connect(userId: string, refreshToken: string) {
  const [credential] = await database
    .insert(credentials)
    .values({
      kind: "mcp_user_token",
      provider: serverId,
      keyId: userId,
      metadata: {},
      encryptedValue: await encryptSecret(ENCRYPTION_KEY, refreshToken),
    })
    .returning({ id: credentials.id });
  if (!credential) throw new Error("credential was not stored");
  credentialIds.push(credential.id);

  await database
    .insert(mcpUserCredentials)
    .values({
      serverId,
      userId,
      credentialId: credential.id,
      scope: "https://www.googleapis.com/auth/drive.readonly",
    })
    .onConflictDoUpdate({
      target: [mcpUserCredentials.serverId, mcpUserCredentials.userId],
      set: { credentialId: credential.id },
    });
  return credential.id;
}

beforeAll(async () => {
  await database
    .insert(agents)
    .values({ id: botId, name: botId, type: "remote_ag_ui", configuration: {} })
    .onConflictDoNothing();

  for (const [id, email] of [
    [askerId, `${askerId}@openbot.test`],
    [otherId, `${otherId}@openbot.test`],
  ]) {
    await database
      .insert(users)
      .values({ id, email, name: id, emailVerified: false })
      .onConflictDoNothing();
  }

  const [existing] = await database
    .select({ id: mcpServers.id, credentialId: mcpServers.credentialId })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  serverWasAlreadyConfigured = existing !== undefined;
  clientBefore = existing?.credentialId ?? null;

  // Written directly, so the test needs no vendor to be reachable. What is under test is which
  // credential gets chosen, not the listing.
  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: "Google Drive",
      vendor: "Google",
      url: "https://drivemcp.googleapis.com/mcp/v1",
      provenance: "first-party",
    })
    .onConflictDoNothing();
  await database
    .insert(mcpTools)
    .values({ serverId, name: toolName, description: "Search files." })
    .onConflictDoNothing();

  // The Bot holds the tool throughout. Everything here is about the person, not the grant.
  await database
    .insert(pluginGrants)
    .values({ kind: "mcp", ref, agentId: botId })
    .onConflictDoNothing();
});

afterAll(async () => {
  await database
    .delete(mcpUserCredentials)
    .where(eq(mcpUserCredentials.serverId, serverId));
  /*
   * Put the deployment's own client pointer back before deleting anything, so a suite that borrowed
   * live configuration leaves it as it found it. Ordered first on purpose: the deletes below remove
   * the credential the row is currently pointing at.
   */
  if (serverWasAlreadyConfigured) {
    await database
      .update(mcpServers)
      .set({ credentialId: clientBefore })
      .where(eq(mcpServers.id, serverId));
  }
  for (const id of credentialIds) {
    await database.delete(credentials).where(eq(credentials.id, id));
  }
  await database.delete(pluginGrants).where(eq(pluginGrants.ref, ref));
  if (!serverWasAlreadyConfigured) {
    await database.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  }
  await database.delete(agents).where(eq(agents.id, botId));
  await database.delete(users).where(eq(users.id, askerId));
  await database.delete(users).where(eq(users.id, otherId));
});

describe("a person who has not connected", () => {
  test("is refused, and told to connect rather than told it broke", () => {
    // A refusal, not an error. Nothing is wrong: they simply have not granted access yet, and the
    // sentence they get should be one they can act on.
    expect(
      store.callTool({ ref, args: {}, botId, actorId: askerId }),
    ).rejects.toThrow(PluginRefusedError);
  });

  test("is not quietly served the deployment's own credential", async () => {
    // The failure this whole table exists to prevent. A fallback here would answer from whatever the
    // deployment could see and look exactly like a correct answer.
    await database
      .update(mcpServers)
      .set({ credentialId: "a-deployment-credential" })
      .where(eq(mcpServers.id, serverId));

    await expect(
      store.callTool({ ref, args: {}, botId, actorId: askerId }),
    ).rejects.toThrow(PluginRefusedError);
    expect(decrypted).toEqual([]);

    await database
      .update(mcpServers)
      .set({ credentialId: null })
      .where(eq(mcpServers.id, serverId));
  });
});

describe("nobody in particular", () => {
  test("cannot borrow a connected person's access", async () => {
    await connect(askerId, askerRefreshToken);
    decrypted.length = 0;

    // The anonymous actor is the empty string, and an empty string must never match a row. A lookup
    // that let it through would hand a run nobody is attributable for whichever grant sorted first.
    await expect(
      store.callTool({ ref, args: {}, botId, actorId: "" }),
    ).rejects.toThrow(PluginRefusedError);
    expect(decrypted).toEqual([]);
  });
});

describe("a person who has connected", () => {
  test("is told plainly when the deployment has registered no client", async () => {
    // The person did their part and cannot fix this one, so the refusal names the administrator's
    // job rather than sending them back to try connecting again.
    await connect(askerId, askerRefreshToken);
    await database
      .update(mcpServers)
      .set({ credentialId: null })
      .where(eq(mcpServers.id, serverId));

    await expect(
      store.callTool({ ref, args: {}, botId, actorId: askerId }),
    ).rejects.toThrow(/OAuth client/);
  });

  test("goes out with their own token and nobody else's", async () => {
    await registerClient();
    await connect(askerId, askerRefreshToken);
    await connect(otherId, otherRefreshToken);
    decrypted.length = 0;
    exchanged.length = 0;

    await store.callTool({ ref, args: {}, botId, actorId: askerId });
    expect(exchanged).toEqual([askerRefreshToken]);
    expect(decrypted).toEqual([accessTokenFrom(askerRefreshToken)]);

    decrypted.length = 0;
    exchanged.length = 0;
    await store.callTool({ ref, args: {}, botId, actorId: otherId });
    expect(exchanged).toEqual([otherRefreshToken]);
    expect(decrypted).toEqual([accessTokenFrom(otherRefreshToken)]);
  });

  test("never sends the refresh token itself to the vendor", async () => {
    // The refresh token is long-lived and reauthorises indefinitely; the access token expires. Only
    // the short-lived one may leave, and a regression here would be invisible in behaviour.
    await registerClient();
    await connect(askerId, askerRefreshToken);
    decrypted.length = 0;

    await store.callTool({ ref, args: {}, botId, actorId: askerId });
    expect(decrypted).not.toContain(askerRefreshToken);
  });

  test("is refused once their credential is revoked, and told to reconnect", async () => {
    const credentialId = await connect(askerId, askerRefreshToken);
    decrypted.length = 0;

    await database
      .update(credentials)
      .set({ revokedAt: new Date() })
      .where(eq(credentials.id, credentialId));

    /*
     * A refusal rather than a thrown vendor error.
     *
     * The vault already refuses a revoked secret, but it does so by throwing, which reaches the
     * person as "that tool could not be called" — indistinguishable from the vendor being down. A
     * withdrawn grant is not a fault, and the sentence should say what to do about it.
     */
    await expect(
      store.callTool({ ref, args: {}, botId, actorId: askerId }),
    ).rejects.toThrow(PluginRefusedError);
    expect(decrypted).toEqual([]);
  });

  test("does not gain access to a server they connected a different one for", async () => {
    // The lookup is keyed on the pair. A row for one server must not satisfy another.
    await connect(askerId, askerRefreshToken);
    decrypted.length = 0;

    await database
      .delete(mcpUserCredentials)
      .where(eq(mcpUserCredentials.serverId, serverId));

    await expect(
      store.callTool({ ref, args: {}, botId, actorId: askerId }),
    ).rejects.toThrow(PluginRefusedError);
    expect(decrypted).toEqual([]);
  });
});
