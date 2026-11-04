import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { mcpTools, users } from "../src/db/schema";
import {
  createPluginStore,
  type PluginStore,
  PluginRefusedError,
} from "../src/plugins/store";
import type { ConnectionsDirectory } from "../src/vault/directory";
import {
  changeAccess,
  removeBots,
  seedBot,
  useTestConfiguration,
} from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  changeServer,
  liveSecrets,
  purgeSecrets,
  removeConnectionsWhere,
  removeServers,
  seedCredential,
  seedGrant,
  seedServer,
  storedSecret,
  storedServer,
  useTestVault,
} from "./support/vault";

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

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

beforeAll(async () => {
  await useTestConfiguration();
});

const suite = randomUUID().slice(0, 8);
const botId = `agent_oauth_bot_${suite}`;
const askerId = `user_oauth_asker_${suite}`;
const otherId = `user_oauth_other_${suite}`;
const serverId = "google-drive";
const toolName = "search_files";
const ref = `${serverId}/${toolName}`;

// 32 zero bytes in base64. A real AES-256 key length, unlike `"x".repeat(44)`, which decodes to 33
// bytes and makes `importKey` throw if anything here ever seals a value with it.
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

/** The refresh tokens each person's row points at, so a test can tell whose was chosen. */
const askerRefreshToken = `refresh-token-for-asker-${suite}`;
const otherRefreshToken = `refresh-token-for-other-${suite}`;

/**
 * Every token the store was about to send, in order.
 *
 * The store hands a token to the MCP client, which is the one thing this test cannot let happen for
 * real. Recording it at the vendor boundary instead answers the only question that matters — whose
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
 * The app's `credentialId` is live configuration: on a deployment somebody uses, it points at the
 * client an administrator registered. This suite has to repoint it to exercise the selection, and it
 * used to leave it repointed at a credential the cleanup then deleted — so the connector afterwards
 * reported "no OAuth client registered yet" and the administrator's own registration was gone.
 *
 * Nothing catches that: Intelligence will hold an app pointing at a secret the vault no longer has.
 */
let clientBefore: string | null = null;
/**
 * Whether this deployment already advertised the tool this suite inserts.
 *
 * The vendor really does advertise `search_files`, so deleting by name regardless would take a real
 * row; never deleting leaves a fixture that reads on screen as a tool the vendor offers.
 */
let toolWasAlreadyAdvertised = false;
const credentialIds: string[] = [];

let store: PluginStore;
let directory: ConnectionsDirectory;

/**
 * The real vault, with the two writes this suite never expects made loud.
 *
 * This suite writes its secrets and grants directly, so that what is under test is the selection
 * rather than the connect flow: a `create` here means the file had quietly started exercising
 * something it did not claim to. Google does not rotate, so no exchange here ever reaches the
 * in-place update either. Revoking is real, because retirement is under test and the assertion is
 * that the vault's secret comes back revoked, which a stand-in cannot show.
 */
function guardedCredentials() {
  const real = createCredentialStore(directory);
  return {
    ...real,
    create: async () => {
      throw new Error("this suite writes credentials directly");
    },
    updateSecret: async () => {
      throw new Error("this suite writes credentials directly");
    },
  };
}

/**
 * Retire whatever this key currently holds, the way the product now does.
 *
 * These fixtures store straight into the vault rather than going through the store, and the vault
 * holds at most one live secret under a name. Re-registering a client or reconnecting a person is a
 * replacement, so the secret it replaces is revoked first; without this the second test to call
 * either helper meets the vault's refusal instead of the behaviour it came to check.
 */
async function retireLive(
  kind: "mcp_oauth_client" | "mcp_user_token",
  keyId: string,
) {
  for (const secret of await liveSecrets({
    kind,
    provider: serverId,
    keyId,
  })) {
    await directory.revokeSecret(secret.id);
  }
}

/** Register the deployment's OAuth client, which is what the app's `credentialId` holds. */
async function registerClient() {
  await retireLive("mcp_oauth_client", "oauth-client");
  const credential = await seedCredential({
    kind: "mcp_oauth_client",
    provider: serverId,
    keyId: "oauth-client",
    metadata: { clientId: CLIENT.clientId },
    plaintext: JSON.stringify(CLIENT),
  });
  credentialIds.push(credential.id);
  await changeServer(serverId, { credentialId: credential.id });
  return credential.id;
}

async function connect(userId: string, refreshToken: string) {
  await retireLive("mcp_user_token", userId);
  const credential = await seedCredential({
    kind: "mcp_user_token",
    provider: serverId,
    keyId: userId,
    plaintext: refreshToken,
  });
  credentialIds.push(credential.id);

  await seedGrant({
    serverId,
    userId,
    credentialId: credential.id,
    scope: "https://www.googleapis.com/auth/drive.readonly",
  });
  return credential.id;
}

/** Remove this suite's two people's grants on the server, never anybody else's. */
function removeOwnGrants(userIds: string[]) {
  return removeConnectionsWhere(
    (connection) =>
      connection.kind === "grant" &&
      connection.serverId === serverId &&
      userIds.includes(connection.userId),
  );
}

beforeAll(async () => {
  directory = await useTestVault();
  store = createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: guardedCredentials(),
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
     * This is where the security property is observable. The access token that reaches the vendor
     * is derived from the refresh token that was spent, so asserting on it proves the whole chain
     * picked one person's grant — rather than proving only that some token was sent.
     */
    exchangeRefreshToken: async ({ client, refreshToken }) => {
      expect(client).toEqual(CLIENT);
      exchanged.push(refreshToken);
      return { accessToken: accessTokenFrom(refreshToken) };
    },
  });

  await seedBot({ id: botId, name: botId });

  for (const [id, email] of [
    [askerId, `${askerId}@openbot.test`],
    [otherId, `${otherId}@openbot.test`],
  ]) {
    await database
      .insert(users)
      .values({ id, email, name: id, emailVerified: false })
      .onConflictDoNothing();
  }

  const existing = await storedServer(serverId);
  serverWasAlreadyConfigured = existing !== null;
  toolWasAlreadyAdvertised =
    (
      await database
        .select({ name: mcpTools.name })
        .from(mcpTools)
        .where(
          and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)),
        )
    ).length > 0;
  clientBefore = existing?.credentialId ?? null;

  // Written directly, so the test needs no vendor to be reachable. What is under test is which
  // credential gets chosen, not the listing.
  if (!existing) {
    await seedServer({
      id: serverId,
      title: "Google Drive",
      vendor: "Google",
      url: "https://www.googleapis.com/drive/v3",
      provenance: "first-party",
    });
  }
  await database
    .insert(mcpTools)
    .values({
      serverId,
      name: toolName,
      vendorName: toolName,
      description: "Search files.",
    })
    .onConflictDoNothing();

  // The Bot holds the tool throughout. Everything here is about the person, not the grant.
  await changeAccess([
    {
      op: "grant",
      botId,
      kind: "mcp",
      ref,
      grantedBy: null,
      grantedAs: "admin",
      ifGranted: "keep",
    },
  ]);
});

afterAll(async () => {
  /*
   * The suite's own two people, never every row for this vendor.
   *
   * `serverId` here is a real catalogue key, so a deployment somebody uses has real connections
   * under it — and deleting by server id took a person's actual Drive connection with it, after
   * their consent had succeeded. The user ids carry this run's random suffix, so nothing outside it
   * can match.
   */
  await removeOwnGrants([askerId, otherId]);
  /*
   * Put the client pointer back before purging anything, so a suite that borrowed live
   * configuration leaves it as it found it. Ordered first on purpose: the purge below removes the
   * credential the app is currently pointing at.
   *
   * UNCONDITIONAL, and it used to be guarded by `serverWasAlreadyConfigured`. On a deployment that
   * already had the server the guard was harmless, which is why this passed locally for as long as
   * it did. On a fresh one the guard skipped and the pointer kept addressing a credential this suite
   * purges, which is exactly the dangling pointer that made a configured connector report having no
   * client. Restoring it is right in both cases: `clientBefore` is null when there was no server to
   * borrow from, which is what the pointer should say.
   */
  await changeServer(serverId, { credentialId: clientBefore });
  await purgeSecrets(credentialIds);
  /*
   * Scoped to this suite's own Bot, never to the ref alone. `ref` is `google-drive/search_files`,
   * a real server and a real tool, so a delete by ref alone removes an administrator's grants for
   * Bots people use. See the same note in plugin-store.integration.test.ts, which this shares.
   */
  await changeAccess([{ op: "revoke", botId, kind: "mcp", ref }]);
  // The fixture tool goes whether or not this suite owns the server, but only if it put it there.
  if (!toolWasAlreadyAdvertised) {
    await database
      .delete(mcpTools)
      .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)));
  }
  if (!serverWasAlreadyConfigured) {
    await removeServers([serverId]);
  }
  await removeBots([botId]);
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
    //
    // A REAL credential, where this used to write the string "a-deployment-credential", a pointer
    // to something that could not exist — so the test was asserting against a state no deployment
    // could reach, which is a weaker claim than it looked. It is now a genuine deployment
    // credential that a fallback could really have spent.
    const deploymentCredential = await registerClient();

    await expect(
      store.callTool({ ref, args: {}, botId, actorId: askerId }),
    ).rejects.toThrow(PluginRefusedError);
    expect(decrypted).toEqual([]);

    // Repointed away before the credential is left behind, so the app never addresses a secret the
    // cleanup purges.
    await changeServer(serverId, { credentialId: null });
    expect(deploymentCredential).toBeTruthy();
  });
});

describe("nobody in particular", () => {
  test("cannot borrow a connected person's access", async () => {
    await connect(askerId, askerRefreshToken);
    decrypted.length = 0;

    // The anonymous actor is the empty string, and an empty string must never match a grant. A lookup
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
    await changeServer(serverId, { credentialId: null });

    await expect(
      store.callTool({ ref, args: {}, botId, actorId: askerId }),
    ).rejects.toThrow(
      /isn't set up yet, so this can't be done\. Ask an admin to finish setting it up\./,
    );
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

    await directory.revokeSecret(credentialId);

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
    // The lookup is keyed on the pair. A grant on one server must not satisfy another.
    await connect(askerId, askerRefreshToken);
    decrypted.length = 0;

    await removeOwnGrants([askerId, otherId]);

    await expect(
      store.callTool({ ref, args: {}, botId, actorId: askerId }),
    ).rejects.toThrow(PluginRefusedError);
    expect(decrypted).toEqual([]);
  });
});

/*
 * OFFBOARDING. "We removed their access" has to be true of the refresh token, not only of the
 * session — the session is the half they cannot use, and the token is the half this deployment is
 * still holding. For a per-person connector it is the first thing a customer asks about.
 */
describe("a connection whose credential no longer works", () => {
  /*
   * A GRANT IS NOT ACCESS, and the two used to be impossible to tell apart from outside.
   *
   * `connectionsFor` reads the grants, which revoking a credential does not touch. Every reader
   * asking "is this person connected" therefore got "does this person have a row", and the in-chat
   * connect card drew "connected" over the very refusal telling them their access was withdrawn —
   * taking away the button that is the only way to get it back.
   */
  test("is listed as revoked rather than as connected", async () => {
    await registerClient();
    const credentialId = await connect(askerId, askerRefreshToken);

    expect(await store.connectionsFor(askerId)).toMatchObject([
      { serverId, revoked: false },
    ]);

    await directory.revokeSecret(credentialId);

    expect(await store.connectionsFor(askerId)).toMatchObject([
      { serverId, revoked: true },
    ]);
  });

  test("a credential gone from the vault out from under it reads as revoked, never as a third state", async () => {
    /*
     * What makes the answer above total, and therefore what makes "revoked" the only way access can
     * be gone. A grant used to point at its credential through a foreign key that did not cascade,
     * so the database refused to make a third state. The vault is Intelligence's now and will purge
     * a secret a grant still names, so the third state can exist; what keeps it from being a third
     * answer is that a grant whose secret is gone reads exactly as a revoked one, and is refused the
     * same way.
     */
    await registerClient();
    const credentialId = await connect(askerId, askerRefreshToken);
    expect(await store.connectionsFor(askerId)).toMatchObject([
      { serverId, revoked: false },
    ]);

    await directory.purgeSecret(credentialId);
    expect(await storedSecret(credentialId)).toBeNull();

    expect(await store.connectionsFor(askerId)).toMatchObject([
      { serverId, revoked: true },
    ]);
    decrypted.length = 0;
    await expect(
      store.callTool({ ref, args: {}, botId, actorId: askerId }),
    ).rejects.toThrow(PluginRefusedError);
    expect(decrypted).toEqual([]);
  });
});

describe("retiring the credentials a person owns", () => {
  /*
   * Counted as a property, not as a number.
   *
   * `connect` above writes vault secrets directly and leaves earlier ones alone, so how many a person
   * has accumulated depends on which tests ran first — and asserting an exact `retired` count would
   * make these pass or fail on suite order rather than on behaviour. What has to be true is that
   * nothing usable is left, which is the same claim however many there were.
   *
   * The product path does not accumulate them: `recordConnection` revokes the previous credential
   * when it repoints the grant.
   */
  const unrevokedTokensFor = async (userId: string) =>
    (await liveSecrets({ kind: "mcp_user_token", keyId: userId })).length;

  test("the vault stops holding a usable secret, and the connection is gone", async () => {
    await registerClient();
    const credentialId = await connect(askerId, askerRefreshToken);

    // Reachable first, so what follows is an assertion about the retirement and not about setup.
    await store.callTool({ ref, args: {}, botId, actorId: askerId });
    expect(exchanged.at(-1)).toBe(askerRefreshToken);

    await store.retireConnectionsFor(askerId, "admin@openbot.local");

    expect((await storedSecret(credentialId))?.revokedAt).not.toBeNull();
    expect(await unrevokedTokensFor(askerId)).toBe(0);

    // The grant goes too, so no page claims a connection this deployment can no longer use.
    expect(await store.connectionsFor(askerId)).toEqual([]);

    // And a call is refused rather than answered from a revoked credential.
    await expect(
      store.callTool({ ref, args: {}, botId, actorId: askerId }),
    ).rejects.toBeInstanceOf(PluginRefusedError);
  });

  /*
   * THE ORPHAN. A grant can go while its credential stays behind (deleting a user's row took their
   * grants with it by cascade): unrevoked, referenced by nothing, reachable from no screen. Looking
   * the owner up in the vault by name instead of through the grants is what makes it reachable at
   * all, so that is asserted rather than assumed.
   */
  test("a credential orphaned by a deleted user row is still retired", async () => {
    await registerClient();
    const credentialId = await connect(otherId, otherRefreshToken);

    // Exactly what the cascade leaves behind.
    await removeOwnGrants([otherId]);

    await store.retireConnectionsFor(otherId, "admin@openbot.local");

    expect((await storedSecret(credentialId))?.revokedAt).not.toBeNull();
    expect(await unrevokedTokensFor(otherId)).toBe(0);
  });

  test("retiring twice is quiet, and nobody owns nothing", async () => {
    await registerClient();
    await connect(askerId, askerRefreshToken);

    expect(
      (await store.retireConnectionsFor(askerId, "admin@openbot.local"))
        .retired,
    ).toBeGreaterThan(0);
    // Already revoked is something an administrator can legitimately do twice.
    expect(
      (await store.retireConnectionsFor(askerId, "admin@openbot.local"))
        .retired,
    ).toBe(0);
    // The empty actor is ANONYMOUS_ACTOR. It owns nothing, and must not match secrets by being empty.
    expect(
      (await store.retireConnectionsFor("", "admin@openbot.local")).retired,
    ).toBe(0);
  });
});

afterAll(async () => {
  await database.$client.close();
});
