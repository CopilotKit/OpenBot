import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { credentials, mcpServers, mcpTools } from "../src/db/schema";
import {
  CustomServerRefusedError,
  createPluginStore,
} from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/**
 * Which address a stored credential may be spent against, and whose it has to be.
 *
 * Pointing a server at a credential is the one place this deployment accepts a *reference* to a
 * secret rather than the secret itself. Everywhere else that a stored value is spent, the value was
 * typed into the same request that stores it: `storeAgentAuth` mints its own row from the key an
 * administrator pasted and hands back an id nobody chose. So this is the field where "which secret"
 * and "which address" can be made to disagree, and the add is what settles the disagreement, because
 * the refresh runs before it returns and sends what it decrypts to the URL from that same request.
 *
 * Two rules, and the second is the one that matters. Naming another server's token was accepted, so
 * a credential could be spent by a server it was never given to. And re-adding a server with a
 * different URL rewrote the address while keeping the credential, so the same token could be sent
 * somewhere else entirely without any cross-server trick at all. Closing only the first leaves the
 * second, which is why they are one question here rather than two.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

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

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    readSecret: async (id: string) => {
      const [row] = await database
        .select({
          encryptedValue: credentials.encryptedValue,
          revokedAt: credentials.revokedAt,
        })
        .from(credentials)
        .where(eq(credentials.id, id));
      return row ?? null;
    },
    create: async () => {
      throw new Error("this suite does not write credentials");
    },
    /**
     * A real revoke, unlike the other suites here, because the chain below turns on whether removing
     * a server actually retires its token. Stubbing this to throw would make the test prove nothing
     * about the case it exists for.
     */
    revoke: async (id: string) => {
      await database
        .update(credentials)
        .set({ revokedAt: new Date() })
        .where(eq(credentials.id, id));
    },
  } as never,
  encryptionKey: KEY,
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

/**
 * What left the deployment, so a refusal can be shown to have stopped the send rather than reported
 * on it afterwards. The vendors here do not exist, so a real request would fail anyway; what this
 * captures is whether one was attempted at all, and what it carried.
 */
let sent: { url: string; authorization: string | null }[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(input as string, init);
    sent.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
    });
    return new Response("{}", { status: 500 });
  }) as typeof fetch;

  const encrypted = async (value: string) => encryptSecret(KEY, value);
  await database.insert(credentials).values([
    {
      id: ownCredentialId,
      kind: "mcp",
      // How `storeMcpToken` records whose token this is: the server it was minted for.
      provider: serverId,
      keyId: `mcp-${serverId}`,
      encryptedValue: await encrypted(OWN_TOKEN),
      metadata: {},
    },
    {
      id: otherCredentialId,
      kind: "mcp",
      provider: otherServerId,
      keyId: `mcp-${otherServerId}`,
      encryptedValue: await encrypted(OTHER_TOKEN),
      metadata: {},
    },
  ]);
});

afterEach(() => {
  sent = [];
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await database.delete(mcpTools).where(like(mcpTools.serverId, `binding-%`));
  await database.delete(mcpServers).where(like(mcpServers.id, `binding-%`));
  await database
    .delete(credentials)
    .where(inArray(credentials.id, [ownCredentialId, otherCredentialId]));
});

async function storedUrl(id: string) {
  const [row] = await database
    .select({ url: mcpServers.url })
    .from(mcpServers)
    .where(eq(mcpServers.id, id));
  return row?.url ?? null;
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
 * still not enough: the address rule only fires when a row is already here, so anything that gets
 * the row out of the way while the token stays live reopens the same door.
 */
describe("a token does not outlive the server it was given to", () => {
  const holderId = `binding-holder-${tag}`;
  const holderCredentialId = randomUUID();
  const HOLDER_TOKEN = `sk-holder-${tag}`;

  beforeAll(async () => {
    await database.insert(credentials).values({
      id: holderCredentialId,
      kind: "mcp",
      provider: holderId,
      keyId: `mcp-${holderId}`,
      encryptedValue: await encryptSecret(KEY, HOLDER_TOKEN),
      metadata: {},
    });
  });

  afterAll(async () => {
    // The server row first: it holds a foreign key onto the credential, so the other order is
    // refused by the database rather than by anything this suite is testing.
    await database.delete(mcpTools).where(eq(mcpTools.serverId, holderId));
    await database.delete(mcpServers).where(eq(mcpServers.id, holderId));
    await database
      .delete(credentials)
      .where(eq(credentials.id, holderCredentialId));
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

    const [row] = await database
      .select({ credentialId: mcpServers.credentialId })
      .from(mcpServers)
      .where(eq(mcpServers.id, holderId));
    expect(row?.credentialId).toBe(holderCredentialId);
  });

  test("removing the server retires its token", async () => {
    await store.removeServer(holderId, "admin@example.com");

    const [row] = await database
      .select({ revokedAt: credentials.revokedAt })
      .from(credentials)
      .where(eq(credentials.id, holderCredentialId));
    expect(row?.revokedAt).not.toBeNull();
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
