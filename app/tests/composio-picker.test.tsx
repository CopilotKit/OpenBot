import { expect, test } from "bun:test";
import type { DirectoryApp } from "@/lib/apps/queries";
import { matchingApps } from "@/lib/plugins/enablement-notes";

/**
 * What the directory picker lists, decided without drawing anything.
 *
 * The screen reads a directory of a few hundred apps, some of which this deployment already has.
 * Two facts about that list are worth pinning: the order it is read in, and that the two fields a
 * decision actually rests on — whether the app is already here, and how much it brings with it —
 * arrive at the row intact.
 *
 * Nothing here renders — `matchingApps` is exported as a function rather than left inline in the
 * map for exactly that reason, so the ordering and the already-added marker can be asserted without
 * a DOM, a router or a query client. It now lives in `lib/plugins/enablement-notes.ts`, which is a
 * plain `.ts` module for the same reason.
 */

/** A minimal but complete directory entry (listAppDirectory), overridable per case. */
function app(overrides: Partial<DirectoryApp> & { id: string }): DirectoryApp {
  return {
    source: "directory",
    title: "App",
    summary: "Does something.",
    appId: null,
    logo: null,
    categories: [],
    actionCount: 1,
    // Required and nullable, never optional: a null is "not measured", which is a different fact
    // from a zero's "measured, and none". A default here would have to pick one, so it picks the
    // one a provider that publishes nothing actually answers with.
    classifiedCount: null,
    permissionCount: null,
    scopedActionCount: null,
    connectsWith: "sign-in",
    ...overrides,
  };
}

const SLACK = app({
  id: "directory:slack",
  title: "Slack",
  summary: "Messages, channels and files.",
  actionCount: 167,
  appId: "composio-slack",
});

const GMAIL = app({
  id: "directory:gmail",
  title: "Gmail",
  summary: "Mail, threads and labels.",
  actionCount: 42,
});

test("an app this deployment already has is offered as added, not as one more thing to add", () => {
  const listed = matchingApps([SLACK, GMAIL]);

  // Once, and carrying the app it was added as, which the row branches on. An app that came back
  // added and lost it would draw a second Add button for something already here, and pressing it
  // would ask the server to add a duplicate.
  const slack = listed.filter((entry) => entry.id === "directory:slack");
  expect(slack).toHaveLength(1);
  expect(slack[0]?.appId).toBe("composio-slack");

  // The other side of the same claim: an app that is genuinely not here stays addable.
  expect(listed.find((entry) => entry.id === "directory:gmail")?.appId).toBe(
    null,
  );
});

test("the size of the decision survives, however large the app", () => {
  const listed = matchingApps([SLACK, GMAIL]);

  // 167 is the real count on Slack, and it is the whole reason the row states one: an app is not
  // a small thing to switch on, and the number is what says so before anybody presses Add.
  expect(
    listed.find((entry) => entry.id === "directory:slack")?.actionCount,
  ).toBe(167);
  expect(
    listed.find((entry) => entry.id === "directory:gmail")?.actionCount,
  ).toBe(42);
});

test("the directory is listed by name, and the vendor's own order is left alone", () => {
  const apps = [SLACK, GMAIL];
  const listed = matchingApps(apps);

  expect(listed.map((entry) => entry.title)).toEqual(["Gmail", "Slack"]);
  // A copy: the query's cached array is the same object every render, and sorting it in place
  // would rewrite what TanStack Query holds.
  expect(apps.map((entry) => entry.title)).toEqual(["Slack", "Gmail"]);
  expect(listed).not.toBe(apps);
});
