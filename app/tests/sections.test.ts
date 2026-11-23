import { expect, test } from "bun:test";
import { sectionForPath, sectionHasPanel } from "@/lib/sections";

/*
 * The strip lights the section the page belongs to, so the rule from an address to a section is
 * what keeps the strip and the page in step.
 */

const routes = [
  { id: "bots", to: "/bots" },
  { id: "routines", to: "/routines" },
  { id: "connections", to: "/connections" },
] as const;

test.each([
  ["/", "conversations"],
  ["/channel/abc", "conversations"],
  ["/channel/new", "conversations"],
  ["/bots", "bots"],
  ["/bots/x/activity", "bots"],
  ["/routines/r1", "routines"],
  // The apps to reconnect after the move are Connections', loaded fresh or reloaded.
  ["/reconnect", "connections"],
  ["/reconnect/gmail", "connections"],
] as const)("%s belongs to %s", (pathname, section) => {
  expect(sectionForPath(pathname, routes)).toBe(section);
});

test.each(["/botsy", "/teams", "/channelled", "/reconnecting"])(
  "%s belongs to no section",
  (pathname) => {
    expect(sectionForPath(pathname, routes)).toBeNull();
  },
);

test("Conversations and Bots have a panel, and the other sections none", () => {
  expect(sectionHasPanel("conversations")).toBe(true);
  expect(sectionHasPanel("bots")).toBe(true);
  expect(sectionHasPanel("routines")).toBe(false);
});
