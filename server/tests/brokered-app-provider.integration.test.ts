/**
 * `addBrokeredApp` composes the row's url, id, provenance and vendor label from the store's
 * provider, and the add-by-URL path reserves both brokers' id namespaces.
 *
 * Case is never normalised: Arcade's toolkit names are case-sensitive, so `arcade://Gmail` and
 * `arcade://gmail` are distinct apps.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import { eq, like, or } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { brokeredConnections, mcpServers } from "../src/db/schema";
import type { BrokerProvider } from "../src/plugins/access";
import type { BrokerConnection, ComposioBroker } from "../src/plugins/broker";
import {
  CustomServerRefusedError,
  createPluginStore,
} from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

async function clean() {
  await database
    .delete(brokeredConnections)
    .where(like(brokeredConnections.app, "bap%"));
  await database
    .delete(mcpServers)
    .where(
      or(
        like(mcpServers.id, "arcade-bap%"),
        like(mcpServers.id, "composio-bap%"),
      ),
    );
}
afterEach(clean);
afterAll(async () => {
  await clean();
  await database.$client.close();
});

/**
 * Every broker member this file does not expect production to reach, by the name it was asked as.
 *
 * EACH ONE THROWS AND RECORDS, because a throw is only as loud as the path that receives it: a
 * `catch` around the call swallows it and the test passes on a broker that was never there. That is
 * how three members of `ConnectedAppBroker` — `revokeAccount` among them — were absent from this
 * stub without a single test noticing. The check below reads the record after every test, so a
 * reach is a red whether or not production let the throw out.
 */
const reached: string[] = [];
const unasked = (what: string) => async (): Promise<never> => {
  reached.push(what);
  throw new Error(`asked the broker to ${what}`);
};
afterEach(() => {
  expect(reached.splice(0)).toEqual([]);
});

function storeFor(
  provider: BrokerProvider,
  ensure: "created" | "standing" = "created",
) {
  const broker: ComposioBroker = {
    // This stub stands in for Composio, whose grant is held locally; see `ConnectedAppBroker.grantIsLocal`.
    grantIsLocal: true,
    // Nothing here asks what auth provider a connection is held under.
    authProviderOf: async () => null,
    // Nothing here reads either member; both are declared because the seam requires a broker to
    // SAY what it runs — see `ConnectedAppBroker.authorizations`.
    authorizations: null,
    grantsFor: unasked("read grants"),
    listApps: unasked("list"),
    ensureAuthConfig: async () => ensure,
    deleteAuthConfig: unasked("delete"),
    authorize: unasked("authorize"),
    isConnected: unasked("check"),
    revoke: unasked("revoke"),
    // Nothing here draws a connect form, connects with typed fields or undoes one account. All three
    // are declared so the stub is a `ConnectedAppBroker` rather than a partial one, and all three
    // fail if reached.
    connectionFields: unasked("read connection fields"),
    connectWithFields: unasked("connect with typed fields"),
    revokeAccount: unasked("revoke one account"),
    accountName: async () => null,
  };
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

async function row(id: string) {
  const [found] = await database
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, id));
  return found;
}

test("an Arcade store enables an arcade:// toolkit under an arcade- id, case kept", async () => {
  const store = storeFor("arcade");
  const record = await store.addBrokeredApp({
    slug: "bapGmail",
    title: "Gmail",
    by: "admin@example.com",
    connection: consent,
  });
  expect(record.id).toBe("arcade-bapGmail");
  expect(record.url).toBe("arcade://bapGmail");
  expect(record.provenance).toBe("arcade");
  const stored = await row("arcade-bapGmail");
  expect(stored?.vendor).toBe("Arcade");
  expect(stored?.provenance).toBe("arcade");
  expect(await row("composio-bapGmail")).toBeUndefined();

  // Distinct apps: the lower-case spelling is its own row, not the same one.
  await store.addBrokeredApp({
    slug: "bapgmail",
    title: "gmail",
    by: "admin@example.com",
    connection: consent,
  });
  expect((await row("arcade-bapgmail"))?.url).toBe("arcade://bapgmail");
  expect((await row("arcade-bapGmail"))?.url).toBe("arcade://bapGmail");
});

test("a Composio store still enables a composio:// app under a composio- id", async () => {
  const store = storeFor("composio");
  const record = await store.addBrokeredApp({
    slug: "bapslack",
    title: "Slack",
    by: "admin@example.com",
    connection: consent,
  });
  expect(record.id).toBe("composio-bapslack");
  expect(record.url).toBe("composio://bapslack");
  expect(record.provenance).toBe("composio");
  expect((await row("composio-bapslack"))?.vendor).toBe("Composio");
  expect(await row("arcade-bapslack")).toBeUndefined();
});

test("each store refuses a slug its own parser cannot read, naming its own vendor", async () => {
  await expect(
    storeFor("arcade").addBrokeredApp({
      slug: "bap.Dotted",
      title: "x",
      by: "admin@example.com",
      connection: consent,
    }),
  ).rejects.toThrow(/^bap\.Dotted is not a name an Arcade app can have\./);
  await expect(
    storeFor("composio").addBrokeredApp({
      slug: "bap dotted",
      title: "x",
      by: "admin@example.com",
      connection: consent,
    }),
  ).rejects.toThrow(/^bap dotted is not a name a Composio app can have\./);
  expect(await row("arcade-bap.Dotted")).toBeUndefined();
  expect(await row("composio-bap dotted")).toBeUndefined();
});

test("re-enabling over a connected Arcade app keeps the recorded scheme", async () => {
  // The connection check reads the STORE'S provider: a composio filter would see no connection
  // here, treat the re-add as free to rewrite, and move the scheme under a live account.
  const store = storeFor("arcade", "created");
  await store.addBrokeredApp({
    slug: "bapkept",
    title: "Kept",
    by: "admin@example.com",
    connection: { kind: "fields", authScheme: "API_KEY" } as BrokerConnection,
  });
  const before = (await row("arcade-bapkept"))?.authScheme;
  await database.insert(brokeredConnections).values({
    provider: "arcade",
    app: "bapkept",
    holder: "deployment",
    vendorUserId: "deployment",
  });
  await store.addBrokeredApp({
    slug: "bapkept",
    title: "Kept",
    by: "admin@example.com",
    connection: consent,
  });
  expect((await row("arcade-bapkept"))?.authScheme).toBe(before ?? null);
});

for (const provider of ["composio", "arcade"] as const) {
  for (const prefix of ["composio-", "arcade-"]) {
    test(`a ${provider} store refuses a URL-added server named ${prefix}x`, async () => {
      const id = `${prefix}bapx`;
      const vendor = prefix === "arcade-" ? "Arcade" : "Composio";
      await expect(
        storeFor(provider).addCustomServer({
          id,
          title: "Collector",
          url: "https://collector.example/mcp",
          by: "admin@example.com",
        }),
      ).rejects.toThrow(
        new CustomServerRefusedError(
          `Names beginning ${prefix} belong to the ${vendor} apps this deployment enables, so ${id} is not a name a server added by URL can take. Choose another.`,
        ).message,
      );
      expect(await row(id)).toBeUndefined();
    });
  }
}

/**
 * WHOSE ACCOUNT AN ENABLED APP IS REACHED THROUGH, WHICH IS A QUESTION A ROW IS NEVER ALLOWED TO
 * LEAVE THIS METHOD WITHOUT AN ANSWER TO.
 *
 * `accountFor` refuses a call against a brokered row whose `account_mode` is null as `ambiguous` —
 * the app is enabled, listed and connectable, and every call it is asked for is declined. So the
 * state these three tests are about is not a tidiness one: it is an app that cannot be used.
 *
 * The two that would fail without the fix are the two the writer used to miss. `addBrokeredApp`
 * settles the column on its INSERT only; its CONFLICT arm converts a row that was NOT brokered
 * into one that is, and the guard that followed asked `schemeKind(recorded) === "none"` — "was
 * this a no-auth app a moment ago" — which a row that was not brokered at all answers `null` to,
 * and a null is `unreadable`, not `none`. The whole block was additionally gated on the auth
 * config having just been CREATED, so a second press of Add could never repair what the first
 * left.
 */
test("converting a row that was not brokered settles whose account the app is", async () => {
  await database.insert(mcpServers).values({
    id: "composio-bapconv",
    title: "Typed",
    vendor: "typed.example",
    url: "https://typed.example/mcp",
    provenance: "custom",
    addedBy: "admin@example.com",
  });

  await storeFor("composio", "created").addBrokeredApp({
    slug: "bapconv",
    title: "Converted",
    by: "admin@example.com",
    connection: consent,
  });

  const stored = await row("composio-bapconv");
  // The conversion itself, so a failure below is read as the mode and not as the upsert.
  expect(stored?.provenance).toBe("composio");
  expect(stored?.url).toBe("composio://bapconv");
  expect(stored?.accountMode).toBe("personal");
});

test("re-enabling an app that never said whose account it is settles it", async () => {
  // The state a deployment is already in, written down: brokered, scheme recorded, mode null.
  await database.insert(mcpServers).values({
    id: "composio-bapstuck",
    title: "Stuck",
    vendor: "Composio",
    url: "composio://bapstuck",
    provenance: "composio",
    authScheme: "OAUTH2",
    addedBy: "admin@example.com",
  });

  // `standing`: the auth config is already there, which is what every press of Add after the first
  // one meets, and what used to skip the whole block.
  await storeFor("composio", "standing").addBrokeredApp({
    slug: "bapstuck",
    title: "Stuck",
    by: "admin@example.com",
    connection: consent,
  });

  expect((await row("composio-bapstuck"))?.accountMode).toBe("personal");
});

test("re-enabling leaves an administrator's Shared choice alone", async () => {
  await database.insert(mcpServers).values({
    id: "composio-bapshared",
    title: "Shared",
    vendor: "Composio",
    url: "composio://bapshared",
    provenance: "composio",
    authScheme: "OAUTH2",
    accountMode: "shared",
    sharedVendorUserId: "openbot-deployment:test:abc",
    addedBy: "admin@example.com",
  });

  await storeFor("composio", "standing").addBrokeredApp({
    slug: "bapshared",
    title: "Shared",
    by: "admin@example.com",
    connection: consent,
  });

  const stored = await row("composio-bapshared");
  expect(stored?.accountMode).toBe("shared");
  expect(stored?.sharedVendorUserId).toBe("openbot-deployment:test:abc");
});

test("an app with no account to hold is left saying so", async () => {
  await storeFor("composio", "created").addBrokeredApp({
    slug: "bapnoauth",
    title: "Hacker News",
    by: "admin@example.com",
    connection: { kind: "no-auth" },
  });

  const stored = await row("composio-bapnoauth");
  expect(stored?.authScheme).toBe("NO_AUTH");
  // `schemeKind` `none`: there is no account, so there is no mode, and the column says that rather
  // than claiming one.
  expect(stored?.accountMode).toBeNull();
});
