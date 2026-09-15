import { expect, test } from "bun:test";
import type { ComposioApp } from "@/lib/plugins/queries";
import { matchingApps } from "@/routes/_authed/admin/plugins/composio";

/**
 * What the Composio picker lists, decided without drawing anything.
 *
 * The screen reads a directory of a few hundred apps, some of which this deployment already has.
 * Two facts about that list are worth pinning: the order it is read in, and that the two fields a
 * decision actually rests on — whether the app is already here, and how much it brings with it —
 * arrive at the row intact.
 *
 * A `.tsx` file because it imports a route module, which is JSX; the precedent is
 * `agent-roster-error.test.tsx`. Nothing here renders, though — `matchingApps` is exported as a
 * function rather than left inline in the map for exactly that reason, so the ordering and the
 * already-added marker can be asserted without a DOM, a router or a query client.
 */

/** A minimal but complete `ComposioApp`, overridable per case. */
function app(overrides: Partial<ComposioApp> & { slug: string }): ComposioApp {
  return {
    name: "App",
    description: "Does something.",
    logo: null,
    categories: [],
    actionCount: 1,
    enabled: false,
    ...overrides,
  };
}

const SLACK = app({
  slug: "slack",
  name: "Slack",
  description: "Messages, channels and files.",
  actionCount: 167,
  enabled: true,
});

const GMAIL = app({
  slug: "gmail",
  name: "Gmail",
  description: "Mail, threads and labels.",
  actionCount: 42,
});

test("an app this deployment already has is offered as added, not as one more thing to add", () => {
  const listed = matchingApps([SLACK, GMAIL]);

  // Once, and carrying the flag the row branches on. An app that came back enabled and lost it
  // would draw a second Add button for something already here, and pressing it would ask the
  // server to add a duplicate.
  const slack = listed.filter((entry) => entry.slug === "slack");
  expect(slack).toHaveLength(1);
  expect(slack[0]?.enabled).toBe(true);

  // The other side of the same claim: an app that is genuinely not here stays addable.
  expect(listed.find((entry) => entry.slug === "gmail")?.enabled).toBe(false);
});

test("the size of the decision survives, however large the app", () => {
  const listed = matchingApps([SLACK, GMAIL]);

  // 167 is the real count on Slack, and it is the whole reason the row states one: an app is not
  // a small thing to switch on, and the number is what says so before anybody presses Add.
  expect(listed.find((entry) => entry.slug === "slack")?.actionCount).toBe(167);
  expect(listed.find((entry) => entry.slug === "gmail")?.actionCount).toBe(42);
});

test("the directory is listed by name, and the vendor's own order is left alone", () => {
  const apps = [SLACK, GMAIL];
  const listed = matchingApps(apps);

  expect(listed.map((entry) => entry.name)).toEqual(["Gmail", "Slack"]);
  // A copy: the query's cached array is the same object every render, and sorting it in place
  // would rewrite what TanStack Query holds.
  expect(apps.map((entry) => entry.name)).toEqual(["Slack", "Gmail"]);
  expect(listed).not.toBe(apps);
});
