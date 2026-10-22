import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { DEV_ACTOR } from "../src/auth/dev-actor";
import { loadConfig } from "../src/config";
import type { BrokerProvider } from "../src/plugins/access";
import type { PluginStore } from "../src/plugins/store";
import { testEnvironment } from "./support/environment";

/** A stand-in for the deployment's vendor key. It must never appear in the page payload. */
const VENDOR_KEY = "vendor-key-sentinel-0123456789";

/** `createApp`'s positions 4-14, which this surface does not supply. */
const UP_TO_PLUGIN_STORE = [
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
] as const;

/** `createApp`'s positions 16-29, between the plugin store and the broker. */
const UP_TO_BROKER = [
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
] as const;

async function pageFor(
  composio?: {
    broker: unknown;
    provider: BrokerProvider;
  },
  /**
   * Which provider the STORE was built for, which is where the page now takes the name from.
   *
   * The two are the same value on any deployment the wiring builds — but they are not the same
   * question, and a deployment with both keys set and `OPENBOT_BROKER_PROVIDER` unset has a store
   * and no broker at all. `provider-undecided.test.ts` is that case; here it defaults to the
   * Composio deployment these cases are written about.
   */
  rowsBelongTo: BrokerProvider = "composio",
) {
  const store = {
    brokerProvider: rowsBelongTo,
    listServers: async () => [],
    listSkills: async () => [],
  } as unknown as PluginStore;
  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: DEV_ACTOR }) },
    } as never,
    { rolesForUser: async () => [] },
    ...UP_TO_PLUGIN_STORE,
    store,
    ...UP_TO_BROKER,
    composio as never,
  );
  const response = await app.request("http://openbot.test/api/plugins");
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("the Plugins page names the active provider", () => {
  test("an Arcade deployment serves arcade", async () => {
    const page = await pageFor(
      {
        broker: { key: VENDOR_KEY },
        provider: "arcade",
      },
      "arcade",
    );
    expect(page.provider).toBe("arcade");
  });

  test("a Composio deployment serves composio", async () => {
    const page = await pageFor({
      broker: { key: VENDOR_KEY },
      provider: "composio",
    });
    expect(page.provider).toBe("composio");
    expect(page.composioConfigured).toBe(true);
  });

  test("a deployment with no broker still serves composio", async () => {
    const page = await pageFor(undefined);
    expect(page.provider).toBe("composio");
    expect(page.composioConfigured).toBe(false);
  });

  test("the name travels, the key and anything derived from it do not", async () => {
    const page = await pageFor(
      {
        broker: { key: VENDOR_KEY, grantIsLocal: true },
        provider: "arcade",
      },
      "arcade",
    );
    expect(Object.keys(page).sort()).toEqual(
      [
        "botsMayCallBack",
        "catalogue",
        "authorizesPerAction",
        "composioConfigured",
        "provider",
        "redirectUri",
        "servers",
        "skills",
      ].sort(),
    );
    const body = JSON.stringify(page);
    expect(body).not.toContain(VENDOR_KEY);
    expect(body).not.toContain("grantIsLocal");
  });
});

/*
 * THE PER-ACTION CAPABILITY, which is a different question from the vendor's name and is answered
 * by a presence test on what the broker declared. The two happen to agree on today's brokers; these
 * cases pin that the payload follows the DECLARATION, because the routes behind the buttons the
 * flag draws (`/servers/:id/authorize`, `/arcade/verify`) gate on that same expression.
 */
describe("the Plugins page declares whether the broker authorizes per action", () => {
  test("a broker with an authorization flow serves true", async () => {
    const page = await pageFor({
      broker: { key: VENDOR_KEY, authorizations: { verify: () => {} } },
      provider: "arcade",
    });
    expect(page.authorizesPerAction).toBe(true);
  });

  test("a Composio deployment serves false", async () => {
    const page = await pageFor({
      broker: { key: VENDOR_KEY, authorizations: null },
      provider: "composio",
    });
    expect(page.authorizesPerAction).toBe(false);
  });

  test("a deployment with no broker serves false", async () => {
    const page = await pageFor(undefined);
    expect(page.authorizesPerAction).toBe(false);
  });

  /*
   * WHERE THE NAME AND THE CAPABILITY DISAGREE, and the capability wins. This is the deployment the
   * name comparison got wrong: `provider` still says arcade, because that is what the copy is
   * written from, and the flag says false, because `/servers/:id/authorize` would refuse it 503.
   */
  test("a broker named arcade with no flow serves arcade and false", async () => {
    const page = await pageFor(
      {
        broker: { key: VENDOR_KEY, authorizations: null },
        provider: "arcade",
      },
      "arcade",
    );
    expect(page.provider).toBe("arcade");
    expect(page.authorizesPerAction).toBe(false);
  });
});
