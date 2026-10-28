// server/tests/directory-vendor-sentences.test.ts
/**
 * The three sentences the Arcade directory screen renders, in the active broker's own name.
 *
 * `apps.error.message` wins over the client's fallback, so a server sentence that spells Composio
 * is what an Arcade operator reads. The directory read, the enable path's directory failure and its
 * not-listed refusal each name the vendor and (for the first two) its key setting; the vendor and
 * the setting come off the active provider's profile.
 *
 * THE COMPOSIO RENDERINGS ARE ASSERTED AS EXACT STRINGS. A regex would pass against a reworded
 * sentence, and rewording a Composio sentence is the one thing this change must not do.
 */
import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { BrokerProvider } from "../src/plugins/access";
import type { ComposioBroker } from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import type { PluginStore } from "../src/plugins/store";

function deployment(provider: BrokerProvider, listApps: () => Promise<never>) {
  const broker = {
    grantIsLocal: true,
    authProviderOf: async () => null,
    authorizations: null,
    authorize: async () => {
      throw new Error("never asked");
    },
    listApps,
  } as unknown as ComposioBroker;
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
      {
        brokerProvider: provider,
        serverUrls: async () => [],
      } as unknown as PluginStore,
      signedIn,
      async () => true,
      {
        publicUrl: "https://openbot.example",
        appUrl: "https://app.example",
        encryptionKey: `${"A".repeat(43)}=`,
        personHasAccess: async () => true,
      },
      { broker, provider },
    ),
  );
  const url = "http://openbot.test/api/plugins/composio/apps";
  return {
    read: () => app.request(url),
    enable: (slug: string) =>
      app.request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug }),
      }),
  };
}

const down = async (): Promise<never> => {
  throw new Error("socket hang up");
};
const empty = async (): Promise<never> => [] as never;

const EXPECTED: Record<
  BrokerProvider,
  { unavailable: string; notListed: string }
> = {
  composio: {
    unavailable:
      "Composio would not answer with its app directory, and said nothing about why. Check that COMPOSIO_API_KEY is this project's key, and check Composio's status if it persists.",
    notListed: "nope is not an app Composio lists for this deployment.",
  },
  arcade: {
    unavailable:
      "Arcade would not answer with its app directory, and said nothing about why. Check that ARCADE_API_KEY is this project's key, and check Arcade's status if it persists.",
    notListed: "nope is not an app Arcade lists for this deployment.",
  },
};

for (const provider of ["composio", "arcade"] as const) {
  describe(`a ${provider} deployment names its own vendor`, () => {
    test("the directory read", async () => {
      const response = await deployment(provider, down).read();
      expect(response.status).toBe(502);
      expect(((await response.json()) as { error: string }).error).toBe(
        EXPECTED[provider].unavailable,
      );
    });
    test("the enable path when the directory is down", async () => {
      const response = await deployment(provider, down).enable("gmail");
      expect(response.status).toBe(502);
      expect(((await response.json()) as { error: string }).error).toBe(
        EXPECTED[provider].unavailable,
      );
    });
    test("the enable path when the app is not listed", async () => {
      const response = await deployment(provider, empty).enable("nope");
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(
        EXPECTED[provider].notListed,
      );
    });
  });
}

describe("an Arcade operator is never told about Composio", () => {
  test("none of the three sentences mentions it", async () => {
    const it = deployment("arcade", down);
    const none = deployment("arcade", empty);
    const bodies = [
      await (await it.read()).text(),
      await (await it.enable("gmail")).text(),
      await (await none.enable("nope")).text(),
    ];
    for (const body of bodies) {
      expect(body).toMatch(/Arcade/);
      expect(body).not.toMatch(/composio/i);
    }
  });
});
