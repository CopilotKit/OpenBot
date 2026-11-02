// server/tests/routes-vendor-vocabulary.test.ts
/**
 * THE SENTENCES `routes.ts` HANDS A PERSON NAME THE BROKER THIS DEPLOYMENT ACTUALLY RUNS.
 *
 * Every refusal on the brokered surface used to spell the literal "Composio" — the app that could
 * not be removed, the app that could not be enabled, the six ways a key app's connect can fail, the
 * consent that could not be minted, and the confirm, re-check and disconnect tails. On an Arcade
 * deployment each of them named a vendor this deployment has no key for and never talks to, and
 * sent the reader to check a key that does not exist.
 *
 * ASSERTED ON BOTH PROVIDERS FROM ONE HARNESS, the way `routes-arcade-urls.test.ts` asserts its
 * four reads. The Arcade half is what was red: the sentence must name Arcade and must not contain
 * the word Composio anywhere. The Composio half is the evidence that nothing about that deployment
 * moved — the same sentence, word for word, but for the vendor's name.
 *
 * TWO AUDIENCES, TWO RULES. The two admin sentences (removing and enabling an app) name the broker,
 * because the admin is the one who holds its key. The connect, confirm, re-check and disconnect
 * sentences answer whoever pressed the button, and since the copy pass they name NO broker at all
 * (see `.claude/skills/openbot-copy/SKILL.md`): the broker is an internal that person cannot act
 * on. Neither rule lets a deployment read the other vendor's name.
 */
import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { BrokerProvider } from "../src/plugins/access";
import type { AccountModeSwitch } from "../src/plugins/account-mode";
import type {
  BrokerApp,
  BrokerField,
  ComposioBroker,
} from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import type { SharedUseStore } from "../src/plugins/shared-use-store";
import type { PluginStore } from "../src/plugins/store";

/** The row each provider holds for the same app, spelled the way that provider spells it. */
const ROW: Record<BrokerProvider, { url: string; toolkit: string }> = {
  composio: { url: "composio://gmail", toolkit: "gmail" },
  arcade: { url: "arcade://Gmail", toolkit: "Gmail" },
};

/** The vendor name a deployment on each provider is entitled to read. */
const VENDOR: Record<BrokerProvider, string> = {
  composio: "Composio",
  arcade: "Arcade",
};

const SERVER_ID = "brokered-gmail";
const TITLE = "Gmail";

/** A failure with no vendor sentence and no authored broker sentence, so the route's own generic is read. */
const opaque = () => new Error("opaque");

function directoryApp(slug: string): BrokerApp {
  return {
    slug,
    name: TITLE,
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

function field(name: string, required: boolean): BrokerField {
  return { name, label: name, help: "", required, secret: true };
}

type Wiring = {
  /** What the row says its authorization config was created as. */
  authScheme?: string | null;
  /** Whether this deployment knows its own public address. */
  appUrl?: string | undefined;
  /** What the broker publishes for a key app's form, or a throw. */
  fields?: () => Promise<BrokerField[]>;
  /** Every store or broker call the route makes on the way out, by name. */
  throwing?: Partial<
    Record<
      | "removeServer"
      | "addBrokeredApp"
      | "connectBrokeredWithFields"
      | "authorize"
      | "confirmBrokeredConnection"
      | "recheckBrokeredConnection"
      | "disconnectBrokered",
      true
    >
  >;
};

function deployment(provider: BrokerProvider, wiring: Wiring = {}) {
  const row = ROW[provider];
  const raise = (name: keyof NonNullable<Wiring["throwing"]>) => {
    if (wiring.throwing?.[name]) throw opaque();
  };

  const store = {
    // The routes take the provider from the store rather than deciding a second
    // time, so a stand-in store has to name it like the real one does.
    brokerProvider: provider,
    serverAddress: async (serverId: string) =>
      serverId === SERVER_ID
        ? {
            id: SERVER_ID,
            title: TITLE,
            url: row.url,
            authScheme:
              wiring.authScheme === undefined ? "OAUTH2" : wiring.authScheme,
          }
        : undefined,
    serverUrls: async () => [row.url],
    accountRefFor: async (_serverId: string, actorId: string) => ({
      ref: {
        holder: "person" as const,
        userId: actorId,
        vendorUserId: actorId,
      },
      title: TITLE,
      mode: "personal" as const,
    }),
    brokeredConnection: async () => null,
    removeServer: async () => {
      raise("removeServer");
    },
    addBrokeredApp: async () => {
      raise("addBrokeredApp");
      return {} as never;
    },
    connectBrokeredWithFields: async () => {
      raise("connectBrokeredWithFields");
      return {} as never;
    },
    confirmBrokeredConnection: async () => {
      raise("confirmBrokeredConnection");
      return { connected: true };
    },
    recheckBrokeredConnection: async () => {
      raise("recheckBrokeredConnection");
      return { verified: true };
    },
    disconnectBrokered: async () => {
      raise("disconnectBrokered");
      return { vendorRevocationRequested: true };
    },
    listSkills: async () => [],
  } as unknown as PluginStore;

  const broker = {
    grantIsLocal: true,
    authProviderOf: async () => null,
    authorizations: null,
    listApps: async () => [directoryApp(row.toolkit)],
    connectionFields: async () =>
      wiring.fields ? await wiring.fields() : ([] as BrokerField[]),
    authorize: async () => {
      raise("authorize");
      return {
        redirectUrl: "https://vendor.example/consent",
        authorizationId: null,
      };
    },
  } as unknown as ComposioBroker;

  const modes = {
    switchMode: async () => ({ ended: [], approved: [] }),
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
        appUrl: "appUrl" in wiring ? wiring.appUrl : "https://app.example",
        encryptionKey: `${"A".repeat(43)}=`,
        personHasAccess: async () => true,
      },
      { broker, provider },
      { modes, use: {} as unknown as SharedUseStore },
    ),
  );

  // Async so each is a `Promise<Response>`: `app.request` answers `Response | Promise<Response>`.
  const post = async (path: string, body: unknown = {}) =>
    app.request(`http://openbot.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  return {
    toolkit: row.toolkit,
    remove: async () =>
      app.request(`http://openbot.test/api/plugins/servers/${SERVER_ID}`, {
        method: "DELETE",
      }),
    enable: () => post("/api/plugins/composio/apps", { slug: row.toolkit }),
    connect: (body?: unknown) =>
      post(`/api/plugins/servers/${SERVER_ID}/connect`, body ?? {}),
    confirm: () => post(`/api/plugins/servers/${SERVER_ID}/connection/confirm`),
    recheck: () => post(`/api/plugins/servers/${SERVER_ID}/connection/recheck`),
    disconnect: async () =>
      app.request(
        `http://openbot.test/api/plugins/servers/${SERVER_ID}/connection`,
        { method: "DELETE" },
      ),
  };
}

/** The admin's sentences, which name the broker, as the request that produces each. */
const ADMIN_CASES: Record<
  string,
  (provider: BrokerProvider) => Promise<Response>
> = {
  "removing an app that would not finish": (provider) =>
    deployment(provider, { throwing: { removeServer: true } }).remove(),
  "enabling an app the broker would not enable": (provider) =>
    deployment(provider, { throwing: { addBrokeredApp: true } }).enable(),
};

/** A person's sentences, which name no broker, as the request that produces each. */
const PERSON_CASES: Record<
  string,
  (provider: BrokerProvider) => Promise<Response>
> = {
  "a key app whose form the broker would not publish": (provider) =>
    deployment(provider, {
      authScheme: "API_KEY",
      fields: () => Promise.reject(opaque()),
    }).connect(),
  "a key app that publishes no boxes at all": (provider) =>
    deployment(provider, {
      authScheme: "API_KEY",
      fields: async () => [],
    }).connect({ values: {} }),
  "a key app that publishes only optional boxes": (provider) =>
    deployment(provider, {
      authScheme: "API_KEY",
      fields: async () => [field("workspace", false)],
    }).connect({ values: {} }),
  "a submission that is not the published form": (provider) =>
    deployment(provider, {
      authScheme: "API_KEY",
      fields: async () => [field("api_key", true)],
    }).connect({ values: { nonsense: "x" } }),
  "a submission missing a required box": (provider) =>
    deployment(provider, {
      authScheme: "API_KEY",
      fields: async () => [field("api_key", true)],
    }).connect({ values: { api_key: "   " } }),
  "a key the store could not connect with": (provider) =>
    deployment(provider, {
      authScheme: "API_KEY",
      fields: async () => [field("api_key", true)],
      throwing: { connectBrokeredWithFields: true },
    }).connect({ values: { api_key: "secret" } }),
  "a row whose scheme this deployment cannot read": (provider) =>
    deployment(provider, { authScheme: "SOMETHING_ELSE" }).connect(),
  "a consent on a deployment with no app URL": (provider) =>
    deployment(provider, { appUrl: undefined }).connect(),
  "a consent the broker would not begin": (provider) =>
    deployment(provider, { throwing: { authorize: true } }).connect(),
  "a confirm the broker would not answer": (provider) =>
    deployment(provider, {
      throwing: { confirmBrokeredConnection: true },
    }).confirm(),
  "a re-check the broker would not answer": (provider) =>
    deployment(provider, {
      throwing: { recheckBrokeredConnection: true },
    }).recheck(),
  "a disconnect the broker would not finish": (provider) =>
    deployment(provider, {
      throwing: { disconnectBrokered: true },
    }).disconnect(),
};

/** Every sentence this file pins. */
const CASES = { ...ADMIN_CASES, ...PERSON_CASES };

async function sentenceOf(
  provider: BrokerProvider,
  name: keyof typeof CASES,
): Promise<string> {
  const response = await CASES[name](provider);
  const body = (await response.json()) as { error?: unknown };
  expect(typeof body.error).toBe("string");
  return body.error as string;
}

describe("an Arcade deployment's admin refusals name Arcade and never Composio", () => {
  for (const name of Object.keys(ADMIN_CASES)) {
    test(name, async () => {
      const sentence = await sentenceOf("arcade", name);
      expect(sentence).not.toContain("Composio");
      expect(sentence).toContain(VENDOR.arcade);
    });
  }
});

describe("and a Composio deployment's admin refusals name Composio and never Arcade", () => {
  for (const name of Object.keys(ADMIN_CASES)) {
    test(name, async () => {
      const sentence = await sentenceOf("composio", name);
      expect(sentence).not.toContain("Arcade");
      expect(sentence).toContain(VENDOR.composio);
    });
  }
});

describe("a person's refusals name no broker on either deployment", () => {
  for (const name of Object.keys(PERSON_CASES)) {
    for (const provider of ["composio", "arcade"] as const) {
      test(`${name} (${provider})`, async () => {
        const sentence = await sentenceOf(provider, name);
        expect(sentence).not.toMatch(/composio|arcade/i);
      });
    }
  }
});

/**
 * And the two sentences differ in NOTHING but the vendor's name — which is what says the fix was a
 * substitution rather than a rewrite. Written as the Arcade sentence with "Arcade" put back to
 * "Composio", compared against the Composio deployment's own answer.
 */
describe("the two deployments' sentences differ only in the vendor's name", () => {
  for (const name of Object.keys(CASES)) {
    test(name, async () => {
      const arcade = await sentenceOf("arcade", name);
      const composio = await sentenceOf("composio", name);
      expect(arcade.replaceAll("Arcade", "Composio")).toBe(composio);
    });
  }
});
