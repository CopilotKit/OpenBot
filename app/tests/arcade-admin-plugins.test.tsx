import { expect, test } from "bun:test";
import { managePaths } from "@/lib/manage-paths";
import {
  brokeredConnectionDescription,
  brokeredDisconnectNote,
  brokeredProvenance,
  brokeredReach,
  directoryRouteDecision,
  moreAppsRow,
  moreAppsSectionDescription,
  providerVocabulary,
} from "@/lib/plugins/provider-vocabulary";
import type { PluginsPage } from "@/lib/plugins/queries";

/**
 * The Plugins screens name no broker at all: a person, the admin included, connects apps through
 * OpenBot. The only vendor word left is the ACTIVE provider's environment variable, where an admin
 * has to set it. Everything here is a pure function, so nothing renders.
 */

const page = (provider?: "composio" | "arcade") =>
  ({ provider }) as PluginsPage;

const everythingSaid = (provider: "composio" | "arcade") =>
  JSON.stringify([
    providerVocabulary(provider).directoryLabel,
    providerVocabulary(provider).directoryDescription,
    moreAppsRow(provider, true),
    moreAppsRow(provider, false).title,
    moreAppsSectionDescription(provider),
    brokeredConnectionDescription(provider),
    brokeredReach(provider),
    brokeredDisconnectNote(provider),
  ]);

test("no sentence names either broker", () => {
  for (const provider of ["composio", "arcade"] as const) {
    expect(everythingSaid(provider)).not.toMatch(/composio|arcade/i);
  }
  expect(managePaths("team").brokerDirectory("arcade").to).toBe(
    "/admin/plugins/arcade",
  );
  expect(brokeredProvenance("arcade")).toBe(true);
});

test("a Composio deployment's words are OpenBot's", () => {
  expect(providerVocabulary("composio")).toEqual({
    directoryLabel: "Browse apps",
    envVar: "COMPOSIO_API_KEY",
    directoryDescription:
      "A few hundred apps. Each person connects their own account.",
  });
  expect(moreAppsSectionDescription("composio")).toBe(
    "More apps people can connect through OpenBot. Nobody here has reviewed them.",
  );
  expect(moreAppsRow("composio", true)).toEqual({
    title: "Browse apps",
    description: "A few hundred apps. Each person connects their own account.",
    linked: true,
  });
  expect(moreAppsRow("composio", false)).toEqual({
    title: "Browse apps",
    description:
      "Not set up. Set COMPOSIO_API_KEY on this deployment to browse its apps.",
    linked: false,
  });
  expect(brokeredConnectionDescription("composio")).toBe(
    "Each person connects their own account through OpenBot.",
  );
  expect(brokeredReach("composio")).toEqual({
    description:
      "This deployment holds one key for every app like this. Each person connects their own account, and a Bot sees only what that person can see. There is no token to paste.",
    badge: "Through OpenBot",
  });
  expect(brokeredDisconnectNote("composio")).toBe(
    "Disconnecting also removes OpenBot's access to your account.",
  );
});

test("the variable an admin sets follows the provider rather than being hard-coded", () => {
  expect(moreAppsRow("arcade", false).description).toContain("ARCADE_API_KEY");
  expect(moreAppsRow("composio", false).description).toContain(
    "COMPOSIO_API_KEY",
  );
});

/*
 * THE ROW GOES SOMEWHERE ON BOTH DEPLOYMENTS. It used to link only on Composio, because only
 * Composio had a directory screen — so on an Arcade deployment the one route that draws the D8
 * coverage warning and the D32 breadth line was unreachable, and two measured warnings rendered
 * nowhere. `linked` now follows the configuration and never the vendor.
 */
test("a configured deployment links to its own directory, whichever provider it is", () => {
  expect(moreAppsRow("arcade", true)).toEqual({
    title: "Browse apps",
    // Arcade's own sentence: it claims no app count, because nobody here has counted Arcade's.
    description:
      "Apps nobody here has reviewed. Each person connects their own account.",
    linked: true,
  });
  expect(moreAppsRow("composio", true).linked).toBe(true);
  // And an unconfigured row still goes nowhere, because there is nowhere to go until the key is set.
  expect(moreAppsRow("arcade", false).linked).toBe(false);
  expect(moreAppsRow("composio", false).linked).toBe(false);
});

test("each provider's directory path is its own route", () => {
  expect(managePaths("team").brokerDirectory("composio").to).toBe(
    "/admin/plugins/composio",
  );
  expect(managePaths("team").brokerDirectory("arcade").to).toBe(
    "/admin/plugins/arcade",
  );
});

test("brokered-ness is read off the row and needs no provider", () => {
  expect(brokeredProvenance("composio")).toBe(true);
  expect(brokeredProvenance("arcade")).toBe(true);
  expect(brokeredProvenance("custom")).toBe(false);
  expect(brokeredProvenance("first-party")).toBe(false);
});

test("the Composio directory route does not answer on an Arcade deployment", () => {
  expect(directoryRouteDecision("composio", page("arcade"))).toBe("redirect");
  expect(directoryRouteDecision("arcade", page("composio"))).toBe("redirect");
  expect(directoryRouteDecision("composio", page("composio"))).toBe("render");
  // An older server that did not say is Composio.
  expect(directoryRouteDecision("composio", page(undefined))).toBe("render");
  // Not answering before the page says which provider this is.
  expect(directoryRouteDecision("composio", undefined)).toBe("pending");
});
