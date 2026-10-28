// server/tests/routes-arcade-urls.test.ts
/**
 * The four places `routes.ts` reads which app a brokered row is, asked on BOTH brokers.
 *
 * Every one of them parsed the url with Composio's own `toolkitOf`, which answers null for
 * `arcade://Gmail` by design — the two parsers are deliberately not interchangeable, which is the
 * whole argument of `TOOLKIT_OF` in `access.ts`. So on an Arcade deployment the account-mode switch
 * refused a brokered app as "not reached through a broker", the directory reported every enabled
 * app as not enabled, the connect route fell past its brokered branch in silence, and
 * `brokeredAccountFor` — step one of authorize, grants and disconnect — refused a perfectly
 * connected app before any account was resolved.
 *
 * EACH CASE IS ASSERTED ON BOTH PROVIDERS, from one harness, and the Composio half is the evidence
 * that nothing about that deployment moved: the same route, the same status, the same body, the
 * same toolkit reaching the store. The Arcade half is what was red.
 *
 * ARCADE CASE IS NOT NORMALIZED ANYWHERE HERE. The row is `arcade://Gmail` and what every
 * assertion expects back is `Gmail`, because `arcade://Gmail` and `arcade://gmail` are distinct
 * apps.
 */
import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { BrokerProvider } from "../src/plugins/access";
import type { AccountModeSwitch } from "../src/plugins/account-mode";
import type { BrokerApp, ComposioBroker } from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import type { AccountRef } from "../src/plugins/shared-accounts";
import type { SharedUseStore } from "../src/plugins/shared-use-store";
import type { PluginStore } from "../src/plugins/store";

/** The row each provider holds for the same app, spelled the way that provider spells it. */
const ROW: Record<BrokerProvider, { url: string; toolkit: string }> = {
  composio: { url: "composio://gmail", toolkit: "gmail" },
  arcade: { url: "arcade://Gmail", toolkit: "Gmail" },
};

const SERVER_ID = "brokered-gmail";

/** One directory entry, named as the provider under test names the app. */
function directoryApp(slug: string): BrokerApp {
  return {
    slug,
    name: "Gmail",
    description: "Mail",
    logo: null,
    categories: [],
    actionCount: 3,
    classifiedCount: null,
    permissionCount: null,
    scopedActionCount: null,
    connection: { kind: "consent" },
  };
}

/**
 * The plugins surface wired to one provider, with every toolkit that reached the broker or the
 * store recorded.
 *
 * Stubs rather than a database: what is under test is which parser read the row's url, and that is
 * decided in the route before any of these are called.
 */
function deployment(provider: BrokerProvider) {
  const row = ROW[provider];
  const confirmed: Array<{ toolkit: string; account: AccountRef }> = [];
  const authorized: Array<{ toolkit: string }> = [];
  const switched: Array<{ serverId: string; mode: string }> = [];

  const store = {
    brokerProvider: provider,
    serverAddress: async (serverId: string) =>
      serverId === SERVER_ID
        ? {
            id: SERVER_ID,
            title: "Gmail",
            url: row.url,
            authScheme: "OAUTH2",
          }
        : undefined,
    serverUrls: async () => [row.url],
    accountRefFor: async (_serverId: string, actorId: string) => ({
      ref: {
        holder: "person" as const,
        userId: actorId,
        vendorUserId: actorId,
      },
      title: "Gmail",
      mode: "personal" as const,
    }),
    brokeredConnection: async () => null,
    confirmBrokeredConnection: async (input: {
      toolkit: string;
      account: AccountRef;
    }) => {
      confirmed.push({ toolkit: input.toolkit, account: input.account });
      return { connected: true };
    },
    listSkills: async () => [],
  } as unknown as PluginStore;

  const broker = {
    grantIsLocal: true,
    // Nothing here asks what auth provider a connection is held under.
    authProviderOf: async () => null,
    authorizations: null,
    listApps: async () => [directoryApp(row.toolkit)],
    authorize: async (input: { toolkit: string }) => {
      authorized.push({ toolkit: input.toolkit });
      return {
        redirectUrl: "https://vendor.example/consent",
        authorizationId: null,
      };
    },
  } as unknown as ComposioBroker;

  const modes = {
    switchMode: async (input: { serverId: string; mode: string }) => {
      switched.push({ serverId: input.serverId, mode: input.mode });
      return { ended: [], approved: [] };
    },
    forgetRule: async () => {},
  } as unknown as AccountModeSwitch;

  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "admin-1",
      email: "admin@example.test",
      role: "admin",
    } as never);
    await next();
  };

  const app = new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      store,
      signedIn,
      async () => true,
      {
        publicUrl: "https://openbot.example",
        appUrl: "https://app.example",
        encryptionKey: `${"A".repeat(43)}=`,
        personHasAccess: async () => true,
      },
      { broker, provider },
      { modes, use: {} as unknown as SharedUseStore },
    ),
  );

  return {
    confirmed,
    authorized,
    switched,
    toolkit: row.toolkit,
    confirm: () =>
      app.request(
        `http://openbot.test/api/plugins/servers/${SERVER_ID}/connection/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
    accountMode: () =>
      app.request(
        `http://openbot.test/api/plugins/servers/${SERVER_ID}/account-mode`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "shared" }),
        },
      ),
    directory: () =>
      app.request("http://openbot.test/api/plugins/composio/apps"),
    connect: () =>
      app.request(
        `http://openbot.test/api/plugins/servers/${SERVER_ID}/connect`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
  };
}

const PROVIDERS: BrokerProvider[] = ["arcade", "composio"];

for (const provider of PROVIDERS) {
  describe(`a ${provider} deployment reads its own urls`, () => {
    test("brokeredAccountFor resolves an account rather than refusing", async () => {
      const it = deployment(provider);
      const response = await it.confirm();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ connected: true });
      expect(it.confirmed).toEqual([
        {
          toolkit: it.toolkit,
          account: {
            holder: "person",
            userId: "admin-1",
            vendorUserId: "admin-1",
          },
        },
      ]);
    });

    test("the account-mode switch accepts the row", async () => {
      const it = deployment(provider);
      const response = await it.accountMode();
      expect(response.status).toBe(200);
      expect(it.switched).toEqual([{ serverId: SERVER_ID, mode: "shared" }]);
    });

    test("the directory reports the app as enabled", async () => {
      const it = deployment(provider);
      const response = await it.directory();
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        apps: Array<{ slug: string; enabled: boolean }>;
      };
      expect(body.apps.map((app) => [app.slug, app.enabled])).toEqual([
        [it.toolkit, true],
      ]);
    });

    test("the connect route takes the brokered branch", async () => {
      const it = deployment(provider);
      const response = await it.connect();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        authorizationUrl: "https://vendor.example/consent",
      });
      expect(it.authorized).toEqual([{ toolkit: it.toolkit }]);
    });
  });
}

/**
 * And the Composio deployment's four answers are byte for byte what they were before the parse was
 * dispatched, which is what makes this a replacement of a parser rather than a change of behaviour.
 * Pinned as raw response text, so a reordered key or a reworded sentence fails here rather than
 * being noticed by inspection.
 */
describe("a Composio deployment answers byte for byte what it did", () => {
  const EXPECTED: Record<
    "confirm" | "accountMode" | "directory" | "connect",
    string
  > = {
    confirm: '{"connected":true}',
    accountMode: '{"ended":[],"approved":[]}',
    directory:
      '{"apps":[{"slug":"gmail","name":"Gmail","description":"Mail","logo":null,"categories":[],"actionCount":3,"classifiedCount":null,"permissionCount":null,"scopedActionCount":null,"connection":{"kind":"consent"},"enabled":true}]}',
    connect: '{"authorizationUrl":"https://vendor.example/consent"}',
  };

  for (const route of Object.keys(EXPECTED) as Array<keyof typeof EXPECTED>) {
    test(`${route} is unchanged`, async () => {
      const response = await deployment("composio")[route]();
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(EXPECTED[route]);
    });
  }

  /**
   * And the Arcade deployment's answers are the same text, the app's own name apart — which is the
   * one thing that differs between two deployments holding the same app at two brokers.
   */
  test("and Arcade answers the same, the app's name apart", async () => {
    for (const route of ["confirm", "accountMode", "connect"] as const) {
      const response = await deployment("arcade")[route]();
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(EXPECTED[route]);
    }
    const directory = await deployment("arcade").directory();
    expect(directory.status).toBe(200);
    expect(await directory.text()).toBe(
      EXPECTED.directory.replace('"slug":"gmail"', '"slug":"Gmail"'),
    );
  });
});
