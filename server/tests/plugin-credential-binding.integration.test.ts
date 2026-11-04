import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  CustomServerRefusedError,
  createPluginStore,
  type PluginStore,
} from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  purgeSecrets,
  removeServers,
  seedCredential,
  storedSecret,
  storedServer,
  useTestVault,
} from "./support/vault";

/**
 * Which address a stored credential may be spent against, and whose it has to be.
 *
 * Pointing a server at a credential is the one place this deployment accepts a *reference* to a
 * secret rather than the secret itself. Everywhere else that a stored value is spent, the value was
 * typed into the same request that stores it: `storeAgentAuth` mints its own secret from the key an
 * administrator pasted and hands back an id nobody chose. So this is the field where "which secret"
 * and "which address" can be made to disagree, and the add is what settles the disagreement, because
 * the refresh runs before it returns and sends what it reveals to the URL from that same request.
 *
 * Two rules, and the second is the one that matters. Naming another server's token was accepted, so
 * a credential could be spent by a server it was never given to. And re-adding a server with a
 * different URL rewrote the address while keeping the credential, so the same token could be sent
 * somewhere else entirely without any cross-server trick at all. Closing only the first leaves the
 * second, which is why they are one question here rather than two.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const KEY = `${"x".repeat(43)}=`;
const tag = randomUUID().slice(0, 8);
const serverId = `binding-${tag}`;
const otherServerId = `binding-other-${tag}`;
const ownCredentialId = randomUUID();
const otherCredentialId = randomUUID();
const OWN_TOKEN = `sk-own-${tag}`;
const OTHER_TOKEN = `sk-other-${tag}`;
const LEGITIMATE_URL = "https://legit.vendor.example/mcp";
const CHOSEN_URL = "https://collector.attacker.example/mcp";

/**
 * The real vault, revoke included, because the chain below turns on whether removing a server
 * actually retires its token. A stand-in would make the test prove nothing about the case it exists
 * for.
 */
let store: PluginStore;

/**
 * What left the deployment, so a refusal can be shown to have stopped the send rather than reported
 * on it afterwards. The vendors here do not exist, so a real request would fail anyway; what this
 * captures is whether one was attempted at all, and what it carried.
 */
let sent: { url: string; authorization: string | null }[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  // Made before `fetch` is replaced below: the vault client keeps the transport it was made with, so
  // what this suite captures is what left for a vendor, never a call to Intelligence.
  const directory = await useTestVault();
  store = createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: createCredentialStore(directory),
    encryptionKey: KEY,
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(input as string, init);
    sent.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
    });
    return new Response("{}", { status: 500 });
  }) as typeof fetch;

  await seedCredential({
    id: ownCredentialId,
    kind: "mcp",
    // How `storeMcpToken` records whose token this is: the server it was minted for.
    provider: serverId,
    keyId: `mcp-${serverId}`,
    plaintext: OWN_TOKEN,
  });
  await seedCredential({
    id: otherCredentialId,
    kind: "mcp",
    provider: otherServerId,
    keyId: `mcp-${otherServerId}`,
    plaintext: OTHER_TOKEN,
  });
});

afterEach(() => {
  sent = [];
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await removeServers([serverId, otherServerId, `binding-open-${tag}`]);
  await purgeSecrets([ownCredentialId, otherCredentialId]);
});

async function storedUrl(id: string) {
  return (await storedServer(id))?.url ?? null;
}

describe("a credential is spent only by the server it belongs to", () => {
  test("another server's token is refused", async () => {
    await expect(
      store.addCustomServer({
        id: serverId,
        title: "Collector",
        url: CHOSEN_URL,
        credentialId: otherCredentialId,
        by: "admin@example.com",
      }),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);

    // The refusal is the whole point only if it happens before the send.
    expect(sent).toEqual([]);
    expect(await storedUrl(serverId)).toBeNull();
  });

  test("the server's own token is accepted", async () => {
    const added = await store.addCustomServer({
      id: serverId,
      title: "Collector",
      url: LEGITIMATE_URL,
      credentialId: ownCredentialId,
      by: "admin@example.com",
    });

    expect(added.id).toBe(serverId);
    expect(await storedUrl(serverId)).toBe(LEGITIMATE_URL);
    // This is the case the field exists for, so the token does go out, to the address it was given.
    expect(sent[0]?.url).toContain("legit.vendor.example");
    expect(sent[0]?.authorization).toContain(OWN_TOKEN);
  });
});

describe("a credential is spent only at the address it was given", () => {
  test("re-adding the server at a different address is refused", async () => {
    // The case a check on whose credential it is cannot see: the token really does belong to this
    // server. What changed is where the server points, and the add would spend the credential
    // against the new address in the same call.
    await expect(
      store.addCustomServer({
        id: serverId,
        title: "Collector",
        url: CHOSEN_URL,
        credentialId: ownCredentialId,
        by: "admin@example.com",
      }),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);

    expect(sent).toEqual([]);
    expect(await storedUrl(serverId)).toBe(LEGITIMATE_URL);
  });

  test("re-adding it at the address it already has still works", async () => {
    // Adding twice is not an attack and must stay ordinary: it is how a title is corrected and how
    // an interrupted add is retried.
    const added = await store.addCustomServer({
      id: serverId,
      title: "Collector, renamed",
      url: LEGITIMATE_URL,
      credentialId: ownCredentialId,
      by: "admin@example.com",
    });

    expect(added.title).toBe("Collector, renamed");
    expect(await storedUrl(serverId)).toBe(LEGITIMATE_URL);
  });

  test("a server holding no credential can still be re-addressed", async () => {
    // Nothing to misdirect, so nothing to refuse. The rule is about spending a secret somewhere it
    // was not entrusted to, not about URLs being immutable.
    const openServerId = `binding-open-${tag}`;
    await store.addCustomServer({
      id: openServerId,
      title: "Open",
      url: LEGITIMATE_URL,
      by: "admin@example.com",
    });

    const moved = await store.addCustomServer({
      id: openServerId,
      title: "Open",
      url: CHOSEN_URL,
      by: "admin@example.com",
    });

    expect(moved.id).toBe(openServerId);
    expect(await storedUrl(openServerId)).toBe(CHOSEN_URL);
    expect(sent.every((call) => call.authorization === null)).toBe(true);
  });
});

/**
 * The way a token used to outlive the server it belonged to, and become spendable again.
 *
 * Three ordinary administrative acts in a row, none of them suspicious on its own. This is the shape
 * that makes "a credential belongs to its server" and "a server keeps its address" both true and
 * still not enough: the address rule only fires when the app is already here, so anything that gets
 * the app out of the way while the token stays live reopens the same door.
 */
describe("a token does not outlive the server it was given to", () => {
  const holderId = `binding-holder-${tag}`;
  const holderCredentialId = randomUUID();
  const HOLDER_TOKEN = `sk-holder-${tag}`;

  beforeAll(async () => {
    await seedCredential({
      id: holderCredentialId,
      kind: "mcp",
      provider: holderId,
      keyId: `mcp-${holderId}`,
      plaintext: HOLDER_TOKEN,
    });
  });

  afterAll(async () => {
    await removeServers([holderId]);
    await purgeSecrets([holderCredentialId]);
  });

  test("re-adding without a token keeps the one the server already holds", async () => {
    // Clearing it was the first link: the row stops naming the credential, so nothing later knows
    // the credential belongs to anything, and nothing retires it.
    await store.addCustomServer({
      id: holderId,
      title: "Holder",
      url: LEGITIMATE_URL,
      credentialId: holderCredentialId,
      by: "admin@example.com",
    });

    await store.addCustomServer({
      id: holderId,
      title: "Holder, renamed",
      url: LEGITIMATE_URL,
      by: "admin@example.com",
    });

    expect((await storedServer(holderId))?.credentialId).toBe(
      holderCredentialId,
    );
  });

  test("removing the server retires its token", async () => {
    await store.removeServer(holderId, "admin@example.com");

    expect((await storedSecret(holderCredentialId))?.revokedAt).not.toBeNull();
  });

  test("a retired token cannot be attached to a server again", async () => {
    // The end of the chain. Even with the row gone, so the address rule has nothing to compare
    // against, the credential itself is no longer spendable.
    sent = [];

    await expect(
      store.addCustomServer({
        id: holderId,
        title: "Holder",
        url: CHOSEN_URL,
        credentialId: holderCredentialId,
        by: "admin@example.com",
      }),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);

    expect(sent).toEqual([]);
  });
});

afterAll(async () => {
  await database.$client.close();
});
