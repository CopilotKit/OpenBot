/**
 * Composio's own toolkits never reach a person browsing for apps.
 *
 * Composio's catalogue lists its own tooling beside the apps it connects: "Composio", "Composio
 * Search" and "Browser Tool", under the slugs `composio`, `composio_search` and `browser_tool`
 * (read off the live catalogue). The app directory showed all three, which put the connector
 * provider's name in front of people on every screen that lists apps.
 *
 * Driven through the real path: the plugin routes over the real Composio broker, with only the
 * vendor's catalogue listing answered from memory, in the shape the live API answers it.
 */
import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { buildComposioClient } from "../src/plugins/composio-adapter";
import type { ComposioVendor } from "../src/plugins/composio-client/model";
import { createPluginRoutes } from "../src/plugins/routes";
import type { PluginStore } from "../src/plugins/store";

/** The catalogue page, as Composio publishes these rows: its own three among real apps. */
const CATALOGUE = [
  { slug: "gmail", name: "Gmail", no_auth: false, auth_schemes: ["OAUTH2"] },
  { slug: "composio", name: "Composio", no_auth: true },
  { slug: "exa", name: "Exa", no_auth: false, auth_schemes: ["API_KEY"] },
  { slug: "composio_search", name: "Composio Search", no_auth: true },
  { slug: "browser_tool", name: "Browser Tool", no_auth: true },
  { slug: "hackernews", name: "Hacker News", no_auth: true },
].map((row) => ({
  ...row,
  composio_managed_auth_schemes: row.auth_schemes ?? [],
  meta: { description: `${row.name}.`, logo: null, categories: [] },
}));

const OWN = ["composio", "composio_search", "browser_tool"];

function refuse(what: string) {
  return async (): Promise<never> => {
    throw new Error(`${what} should not have been called in this test.`);
  };
}

function deployment() {
  const vendor = {
    tools: {
      list: refuse("tools.list"),
      getRawComposioToolBySlug: refuse("tools.getRawComposioToolBySlug"),
      execute: refuse("tools.execute"),
    },
    toolkits: {
      list: async () => ({ items: CATALOGUE, next_cursor: null }),
      retrieve: refuse("toolkits.retrieve"),
    },
    authConfigs: {
      list: refuse("authConfigs.list"),
      create: refuse("authConfigs.create"),
      delete: refuse("authConfigs.delete"),
    },
    connectedAccounts: {
      list: refuse("connectedAccounts.list"),
      link: refuse("connectedAccounts.link"),
      create: refuse("connectedAccounts.create"),
      delete: refuse("connectedAccounts.delete"),
    },
  } as unknown as ComposioVendor;
  const { broker } = buildComposioClient(vendor);

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
        brokerProvider: "composio",
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
      { broker, provider: "composio" },
    ),
  );
  const url = "http://openbot.test/api/plugins/composio/apps";
  return {
    broker,
    slugs: async (query = "") => {
      const response = await app.request(
        query ? `${url}?q=${encodeURIComponent(query)}` : url,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { apps: { slug: string }[] };
      return body.apps.map((entry) => entry.slug);
    },
    enable: (slug: string) =>
      app.request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug }),
      }),
  };
}

describe("the app directory leaves out Composio's own toolkits", () => {
  test("browsing lists every other app and none of Composio's own", async () => {
    expect(await deployment().slugs()).toEqual(["gmail", "exa", "hackernews"]);
  });

  test("searching for them finds nothing of Composio's, and Exa still turns up", async () => {
    const it = deployment();
    expect(await it.slugs("composio")).toEqual([]);
    expect(await it.slugs("browser")).toEqual([]);
    expect(await it.slugs("search")).toEqual([]);
    expect(await it.slugs("exa")).toEqual(["exa"]);
  });

  test("the directory every other caller reads leaves them out too", async () => {
    const apps = await deployment().broker.listApps();
    for (const slug of OWN)
      expect(apps.map((entry) => entry.slug)).not.toContain(slug);
  });

  test("enabling one by hand is refused as not listed", async () => {
    const it = deployment();
    for (const slug of OWN) {
      const response = await it.enable(slug);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(
        `${slug} isn't one of the apps you can connect.`,
      );
    }
  });
});
