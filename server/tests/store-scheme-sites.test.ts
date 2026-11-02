/**
 * Broker-specific store behavior: connection listings, probes and reserved screen names
 * use the configured provider, and adding an app preserves its scheme.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  brokeredConnections,
  mcpServers,
  mcpTools,
  users,
} from "../src/db/schema";
import { BROKERED_PROFILE, type BrokerProvider } from "../src/plugins/access";
import type { BrokerConnection } from "../src/plugins/broker";
import {
  CustomServerRefusedError,
  createPluginStore,
} from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { stubBroker } from "./support/stub-broker";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);

/** Every row this file writes is named `sss…`, so the cleanup can take the whole family. */
const tag = (name: string) => `sss${name}${suite}`;

async function clean() {
  await database.delete(mcpTools).where(like(mcpTools.serverId, "%sss%"));
  await database
    .delete(brokeredConnections)
    .where(like(brokeredConnections.app, "%sss%"));
  await database.delete(mcpServers).where(like(mcpServers.id, "%sss%"));
  // The screen names themselves: a refusal that regressed would leave a row behind, and the row
  // would then make every later run of those tests fail for the wrong reason.
  await database
    .delete(mcpServers)
    .where(inArray(mcpServers.id, ["composio", "arcade"]));
  await database.delete(users).where(like(users.id, "%sss%"));
}
afterEach(clean);
afterAll(async () => {
  await clean();
  await database.$client.close();
});

/**
 * The broker, built by `stubBroker`: every member this file does not provide THROWS AND RECORDS.
 *
 * A throw is only as loud as the path that receives it: a `catch` around the call swallows it and
 * the test passes on a broker that was never there. That is how three members of
 * `ConnectedAppBroker` — `revokeAccount` among them — were absent from this stub without a single
 * test noticing (round-2 C8a). The check below reads the record after every test, so a reach is a
 * red whether or not production let the throw out. Only what these paths actually reach is
 * provided; nothing here reads grants, lists, deletes, authorizes, checks, revokes, draws a connect
 * form, connects with typed fields or undoes one account.
 */
const stub = stubBroker({
  grantIsLocal: true,
  // Nothing here reads it; declared because the seam requires a broker to SAY what it runs — see
  // `ConnectedAppBroker.authorizations`.
  authorizations: null,
  // Nothing here asks what auth provider a connection is held under.
  authProviderOf: async () => null,
  ensureAuthConfig: async () => "created",
  accountName: async () => null,
});
afterEach(() => {
  stub.expectNothingUnprovidedReached();
});

function storeFor(provider: BrokerProvider) {
  const broker = stub.broker;
  return createPluginStore({
    brokerProvider: provider,
    database,
    auditStore: createAuditStore(database),
    credentials: {
      readSecret: async () => null,
      create: async () => {
        throw new Error("vault");
      },
      updateSecret: async () => {
        throw new Error("vault");
      },
      rotate: async () => {
        throw new Error("vault");
      },
      isLive: async () => {
        throw new Error("vault");
      },
      findLiveByKey: async () => {
        throw new Error("vault");
      },
      revoke: async () => {
        throw new Error("vault");
      },
    },
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
  });
}

const consent: BrokerConnection = { kind: "consent" };

/** The app slug each broker's rows are written at here; Arcade's case is never normalised. */
const APP: Record<BrokerProvider, string> = {
  composio: tag("gmail"),
  arcade: tag("Gmail"),
};

async function seedApp(provider: BrokerProvider, serverId: string) {
  await database.insert(mcpServers).values({
    id: serverId,
    title: "Gmail",
    vendor: BROKERED_PROFILE[provider].vendor,
    url: `${BROKERED_PROFILE[provider].scheme}${APP[provider]}`,
    provenance: provider,
    authScheme: "API_KEY",
  });
}

async function seedPersonConnection(provider: BrokerProvider, userId: string) {
  await database.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    name: "asker",
    emailVerified: true,
    groups: [],
  });
  await database.insert(brokeredConnections).values({
    provider,
    app: APP[provider],
    holder: "person",
    userId,
    vendorUserId: userId,
  });
}

/* (a) The record itself, in the one module allowed to spell a scheme. */
test("BROKERED_PROFILE lives in access.ts and answers for both brokers", () => {
  expect(BROKERED_PROFILE.composio).toEqual({
    scheme: "composio://",
    idPrefix: "composio-",
    vendor: "Composio",
    envVar: "COMPOSIO_API_KEY",
  });
  expect(BROKERED_PROFILE.arcade).toEqual({
    scheme: "arcade://",
    idPrefix: "arcade-",
    vendor: "Arcade",
    envVar: "ARCADE_API_KEY",
  });
});

/* (b) The connections listing resolves each app at the ACTIVE broker's scheme. */
for (const provider of ["composio", "arcade"] as const) {
  test(`brokeredConnectionsFor names the ${provider} row at the ${provider} scheme`, async () => {
    const serverId = tag(`${provider}row`);
    const userId = tag(`${provider}user`);
    await seedApp(provider, serverId);
    await seedPersonConnection(provider, userId);

    const rows = await storeFor(provider).brokeredConnectionsFor(userId);
    expect(rows.map((row) => row.serverId)).toEqual([serverId]);
  });
}

test("brokeredConnectionsFor drops a connection whose app has no row at that scheme", async () => {
  // The other broker's row is not this broker's app: a scheme read off a literal would have found
  // it anyway on Composio, and found nothing at all on Arcade.
  const userId = tag("crossuser");
  await seedApp("composio", tag("composiorow"));
  await seedPersonConnection("arcade", userId);
  expect(await storeFor("arcade").brokeredConnectionsFor(userId)).toEqual([]);
});

/* (c) The probe refuses on a broker whose check nobody has written, rather than dialling Composio. */
async function probeOn(provider: BrokerProvider) {
  const serverId = tag(`${provider}probe`);
  await seedApp(provider, serverId);
  await database.insert(mcpTools).values({
    serverId,
    name: "GMAIL_GET_ME",
    vendorName: "GMAIL_GET_ME",
    description: "Who this key belongs to",
    inputSchema: {},
    effect: "read",
    destructive: false,
    version: "20260101_00",
  });
  return await storeFor(provider).probeBrokeredConnection({
    toolkit: APP[provider],
    account: { holder: "person", userId: tag("probeuser"), vendorUserId: "v" },
  });
}

test("the probe refuses on Arcade rather than dialling Composio", async () => {
  const probed = await probeOn("arcade");
  expect(probed).toEqual({
    outcome: "unreachable",
    probe: null,
    attempted: "GMAIL_GET_ME",
    sentence:
      "This deployment brokers its apps through Arcade, and the only connection check this deployment knows how to make is Composio's. Nothing was asked about this connection, so nothing is recorded about it.",
  });
});

test("the probe on Composio still reaches the Composio transport", async () => {
  const probed = await probeOn("composio");
  // No client is installed in a test process, so the transport refuses before it dials — which is
  // the point: the sentence is the TRANSPORT'S, not the refusal above.
  expect(probed.outcome).toBe("unreachable");
  expect(probed).toHaveProperty("attempted", "GMAIL_GET_ME");
  expect((probed as { sentence: string }).sentence).toContain(
    "Apps like this aren't set up yet",
  );
});

/* (d) Both brokers' screen names are reserved, each refused in its own sentence. */
for (const [id, vendor] of [
  ["composio", "Composio"],
  ["arcade", "Arcade"],
] as const) {
  for (const provider of ["composio", "arcade"] as const) {
    test(`a ${provider} store refuses a server hand-typed as ${id}`, async () => {
      await expect(
        storeFor(provider).addCustomServer({
          id,
          title: "Collector",
          url: "https://collector.example/mcp",
          by: "admin@example.com",
        }),
      ).rejects.toThrow(
        new CustomServerRefusedError(
          `${id} is the name of this deployment's own ${vendor} screen, so a server added there could never be opened. Choose another.`,
        ).message,
      );
      const [found] = await database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(inArray(mcpServers.id, ["composio", "arcade"]));
      expect(found).toBeUndefined();
    });
  }
}

test("the brokered id-prefix refusal is untouched by the screen-name one", async () => {
  // Six lines apart and about different things: `arcade` is a screen, `arcade-x` is a namespace.
  await expect(
    storeFor("composio").addCustomServer({
      id: "arcade-x",
      title: "Collector",
      url: "https://collector.example/mcp",
      by: "admin@example.com",
    }),
  ).rejects.toThrow(
    "Names beginning arcade- belong to the Arcade apps this deployment enables",
  );
});

/* And `addBrokeredApp` keeps writing at the record's scheme, which is where the record came from. */
for (const provider of ["composio", "arcade"] as const) {
  test(`addBrokeredApp still writes a ${provider} row at the record's scheme`, async () => {
    const record = await storeFor(provider).addBrokeredApp({
      slug: APP[provider],
      title: "Gmail",
      by: "admin@example.com",
      connection: consent,
    });
    expect(record.url).toBe(
      `${BROKERED_PROFILE[provider].scheme}${APP[provider]}`,
    );
    expect(record.id).toBe(
      `${BROKERED_PROFILE[provider].idPrefix}${APP[provider]}`,
    );
  });
}
