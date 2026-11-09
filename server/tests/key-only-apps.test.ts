import { describe, expect, test } from "bun:test";
import { buildComposioClient } from "../src/plugins/composio-adapter";
import { displayName } from "../src/plugins/app-names";
import { appOf, connectionOf } from "../src/plugins/composio-vendor";
import {
  connectionGuide,
  fieldsForPerson,
  KEY_GUIDES,
} from "../src/plugins/key-guides";
import captured from "./fixtures/composio-key-apps.json";

/**
 * Connecting an app that only takes a key, as a person meets it.
 *
 * Reported from OpenBot Desktop 0.3.3: pressing Connect on 1Password opened a form asking for a
 * "Base URL" and a "Bearer Token", worded for a developer, with nowhere to go to get either. The
 * person expected a sign-in. Composio has none for 1Password (it publishes `API_KEY` and nothing it
 * holds a client for), so the form is right; what was wrong is that nothing said so, or where the
 * key comes from.
 *
 * Every row and detail here is Composio's own answer, captured read-only on 2026-11-08 into
 * `fixtures/composio-key-apps.json`.
 */

type Row = Parameters<typeof connectionOf>[0];
const row = (slug: string): Row => {
  const found = captured.catalogue.find((entry) => entry.slug === slug);
  if (!found) throw new Error(`${slug} is not in the captured catalogue`);
  return found as Row;
};

/** A vendor whose only answer is the captured detail; anything else names itself and fails. */
function vendorAnswering(details: Record<string, unknown>) {
  const refuse = (what: string) => async () => {
    throw new Error(`${what} should not have been called in this test.`);
  };
  return {
    tools: {
      list: refuse("tools.list"),
      getRawComposioToolBySlug: refuse("tools.getRawComposioToolBySlug"),
      execute: refuse("tools.execute"),
    },
    toolkits: {
      list: refuse("toolkits.list"),
      retrieve: async (slug: string) => {
        if (!(slug in details))
          throw new Error(`no captured detail for ${slug}`);
        return details[slug];
      },
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
  };
}

describe("an app with a sign-in never asks for a key", () => {
  /*
   * HubSpot publishes OAUTH2 and API_KEY, and Composio holds an OAuth client for it. The sign-in
   * wins, so the connect flow is a link to HubSpot's own consent page and no form is ever drawn.
   */
  test("HubSpot, which also takes a key, connects by signing in", () => {
    expect(row("hubspot").auth_schemes).toEqual(["OAUTH2", "API_KEY"]);
    expect(connectionOf(row("hubspot"))).toEqual({ kind: "consent" });
    expect(connectionOf(row("gmail"))).toEqual({ kind: "consent" });
  });

  test("1Password, which has no sign-in, is the key form", () => {
    expect(connectionOf(row("_1password"))).toEqual({
      kind: "fields",
      authScheme: "API_KEY",
    });
  });
});

describe("a key-only app's form says where the key comes from", () => {
  const { broker } = buildComposioClient(
    vendorAnswering(captured.details) as never,
  );

  test("the 1Password form is relabelled for a person, under the names the provider reads", async () => {
    const published = await broker.connectionFields({
      toolkit: "_1password",
      authScheme: "API_KEY",
    });
    // What main drew, verbatim from the provider.
    expect(published.map((field) => field.label)).toEqual([
      "Base URL",
      "Bearer Token",
    ]);

    const shown = fieldsForPerson("_1password", published);
    expect(shown.map((field) => field.name)).toEqual([
      "full",
      "generic_api_key",
    ]);
    expect(shown.map((field) => field.label)).toEqual([
      "Connect server address",
      "Access token",
    ]);
    expect(shown[0]?.help).toContain("https://connect.example.com");
    expect(shown[1]?.secret).toBe(true);
  });

  test("the guide for 1Password links to 1Password's own page for making the token", async () => {
    const published = await broker.connectionGuideUrl?.({
      toolkit: "_1password",
      authScheme: "API_KEY",
    });
    // Composio publishes no link for 1Password, so the maintained map answers.
    expect(published).toBeNull();
    const guide = connectionGuide({
      toolkit: "_1password",
      title: "1Password",
      published: published ?? null,
    });
    expect(guide.url).toBe("https://www.1password.dev/connect/get-started");
    expect(guide.steps).toContain("Connect server");
  });

  test("a link Composio publishes is used ahead of the map", async () => {
    const published = await broker.connectionGuideUrl?.({
      toolkit: "braze",
      authScheme: "API_KEY",
    });
    expect(published).toBe(
      "https://www.braze.com/docs/api/basics#creating-a-rest-api-key",
    );
    expect(
      connectionGuide({
        toolkit: "braze",
        title: "Braze",
        published: published ?? null,
      }).url,
    ).toBe("https://www.braze.com/docs/api/basics#creating-a-rest-api-key");
  });

  test("an app missing from the map still gets steps, and no guessed link", () => {
    const guide = connectionGuide({
      toolkit: "0codekit",
      title: "0CodeKit",
      published: null,
    });
    expect(guide.url).toBeNull();
    expect(guide.steps).toContain("0CodeKit");
  });

  test("a link to the broker's own site is never shown", () => {
    expect(
      connectionGuide({
        toolkit: "0codekit",
        title: "0CodeKit",
        published: "https://composio.dev/toolkits/0codekit",
      }).url,
    ).toBeNull();
  });
});

describe("the broker's name never reaches the form", () => {
  /*
   * Instantly's own help sentence, verbatim from Composio's catalogue on 2026-11-08, names the
   * broker to the person filling the box in.
   */
  test("a provider's help sentence naming it says OpenBot instead", () => {
    const [field] = fieldsForPerson("instantly", [
      {
        name: "generic_api_key",
        label: "Instantly API Key",
        help: "Your Instantly API key — lets Composio access your campaigns and leads. Create one under Settings → Integrations → API Keys; must be a v2 key (v1 keys no longer work).",
        required: true,
        secret: true,
      },
    ]);
    expect(field?.help).not.toMatch(/composio/i);
    expect(field?.help).toContain("lets OpenBot access your campaigns");
  });

  test("no guide in the map names it or links to it", () => {
    for (const [slug, guide] of Object.entries(KEY_GUIDES)) {
      const text = [
        guide.steps,
        guide.url,
        ...Object.values(guide.fields ?? {}).flatMap((field) => [
          field.label ?? "",
          field.help ?? "",
        ]),
      ].join(" ");
      expect(`${slug}: ${text}`).not.toMatch(/composio/i);
      expect(new URL(guide.url).protocol).toBe("https:");
    }
  });
});

describe("an app is named as its brand spells it", () => {
  /*
   * Composio's catalogue names 1Password "1password", and the directory row said "Needs a key
   * from 1password". Enabling the app stores its title from the same name, so the tile and the
   * app page would have said it too.
   */
  test("the directory names 1Password with its capitals, and leaves PostHog alone", () => {
    expect(row("_1password").name).toBe("1password");
    expect(appOf(row("_1password"), 0).name).toBe("1Password");
    expect(appOf(row("posthog"), 0).name).toBe("PostHog");
    expect(appOf(row("hubspot"), 0).name).toBe("HubSpot");
  });

  /*
   * The other lowercase names in the catalogue on 2026-11-08: a plain word gets a capital, and a
   * domain-style brand written lowercase on purpose is left as it is.
   */
  test("a lowercase word gets a capital; a domain-style name is left as written", () => {
    expect(displayName("mailfloss", "mailfloss")).toBe("Mailfloss");
    expect(displayName("bexio", "bexio")).toBe("Bexio");
    expect(displayName("incident_io", "incident.io")).toBe("incident.io");
    expect(displayName("urlscanio", "urlscan.io")).toBe("urlscan.io");
    expect(displayName("7shifts", "7shifts")).toBe("7shifts");
  });
});
