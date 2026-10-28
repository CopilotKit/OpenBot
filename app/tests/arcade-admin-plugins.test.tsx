import { expect, test } from "bun:test";
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
 * The admin Plugins screens carry the ACTIVE provider's vocabulary only (spec D11). Everything here
 * is a pure function, so nothing renders.
 */

const page = (provider?: "composio" | "arcade") =>
  ({ provider }) as PluginsPage;

test("an Arcade deployment names Arcade and carries nothing Composio-specific", () => {
  const everything = JSON.stringify([
    providerVocabulary("arcade"),
    moreAppsRow("arcade", true),
    moreAppsRow("arcade", false),
    moreAppsSectionDescription("arcade"),
    brokeredConnectionDescription("arcade"),
    brokeredReach("arcade"),
    brokeredDisconnectNote("arcade"),
  ]);
  expect(everything).not.toMatch(/composio/i);
  expect(providerVocabulary("arcade").envVar).toBe("ARCADE_API_KEY");
  expect(providerVocabulary("arcade").directoryPath).toBe(
    "/admin/plugins/arcade",
  );
  expect(brokeredProvenance("arcade")).toBe(true);
});

test("a Composio deployment keeps today's exact wording", () => {
  expect(providerVocabulary("composio")).toEqual({
    name: "Composio",
    directoryLabel: "Browse Composio",
    envVar: "COMPOSIO_API_KEY",
    directoryPath: "/admin/plugins/composio",
    // Composio's configured-branch sentence, verbatim: it used to be a literal inside a
    // `provider === "composio"` branch in `moreAppsRow`, and moving it here is what let that
    // branch go.
    directoryDescription:
      "A few hundred apps. Each person connects their own account.",
  });
  expect(moreAppsSectionDescription("composio")).toBe(
    "Apps from Composio. Nobody here has reviewed them.",
  );
  expect(moreAppsRow("composio", true)).toEqual({
    title: "Browse Composio",
    description: "A few hundred apps. Each person connects their own account.",
    linked: true,
  });
  expect(moreAppsRow("composio", false)).toEqual({
    title: "Composio",
    description:
      "Not set up. Set COMPOSIO_API_KEY on this deployment to browse its apps.",
    linked: false,
  });
  expect(brokeredConnectionDescription("composio")).toBe(
    "Reached through Composio, which holds each person's own account.",
  );
  expect(brokeredReach("composio")).toEqual({
    description:
      "Composio holds the account. This deployment sends one key and who is asking. Each person connects their own, and a Bot sees only what that person can see. There is no token to paste.",
    badge: "Through Composio",
  });
  expect(brokeredDisconnectNote("composio")).toBe(
    "Disconnecting also ends the account at Composio.",
  );
});

test("the vocabulary follows the provider rather than being hard-coded", () => {
  expect(moreAppsRow("arcade", false).title).toBe("Arcade");
  expect(moreAppsRow("arcade", false).description).toContain("ARCADE_API_KEY");
  expect(brokeredReach("arcade").badge).toBe("Through Arcade");
  expect(brokeredDisconnectNote("arcade")).toContain("Arcade");
});

/*
 * THE ROW GOES SOMEWHERE ON BOTH DEPLOYMENTS. It used to link only on Composio, because only
 * Composio had a directory screen — so on an Arcade deployment the one route that draws the D8
 * coverage warning and the D32 breadth line was unreachable, and two measured warnings rendered
 * nowhere. `linked` now follows the configuration and never the vendor.
 */
test("a configured deployment links to its own directory, whichever provider it is", () => {
  expect(moreAppsRow("arcade", true)).toEqual({
    title: "Browse Arcade",
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
  expect(providerVocabulary("composio").directoryPath).toBe(
    "/admin/plugins/composio",
  );
  expect(providerVocabulary("arcade").directoryPath).toBe(
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
