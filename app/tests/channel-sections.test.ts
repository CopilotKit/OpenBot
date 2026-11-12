import { expect, test } from "bun:test";
import type { SidebarSections } from "@openbot/shared/user-preferences";
import type { ChannelSummary } from "../src/lib/channels/queries";
import {
  collapsedSections,
  conversationSections,
  isGroupChat,
  mergeSidebarSections,
  moveToProjectOffers,
  sectionConversationCount,
  sectionVisible,
  toggledSidebarSection,
} from "../src/lib/channels/sections";
import type { Project } from "../src/lib/projects/queries";

/*
 * Where a conversation goes and how a section folds, without a screen in the way.
 *
 * `sidebar-conversation-sections.test.tsx` proves the answer reaches the rendered tree; this file
 * holds the answer itself, so a rule can be read and corrected without a router, a query client and
 * a DOM. The rules are the feature: a channel filed in a folder is drawn there and nowhere else, an
 * orphaned file reference falls back rather than vanishing, a search opens what it matched without
 * overwriting the fold somebody chose.
 */

/** A minimal but fully-typed channel summary, so tests build real objects rather than casts. */
function channel(
  id: string,
  overrides: Partial<ChannelSummary> = {},
): ChannelSummary {
  return {
    id,
    name: id,
    agentIds: ["bot-1"],
    threadId: `thread-${id}`,
    active: true,
    summary: null,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

function project(id: string, name: string): Project {
  return {
    id,
    name,
    sortOrder: 0,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    channelIds: [],
  };
}

const OPEN: SidebarSections = { group: false, direct: false, projects: false };

test("a second person or a second Bot makes a group, and one of each stays a 1:1", () => {
  /*
   * The two shapes the sidebar can see, and both are enough on their own: two people sharing one
   * Bot is shared work, one person with two Bots is a room. `memberCount` is absent on a server that
   * predates projects, and absence has to read as the 1:1 those channels always were rather than
   * turning every existing conversation into a group.
   */
  expect(isGroupChat(channel("two-people", { memberCount: 2 }))).toBe(true);
  expect(
    isGroupChat(channel("two-bots", { agentIds: ["bot-1", "bot-2"] })),
  ).toBe(true);
  expect(isGroupChat(channel("one-on-one", { memberCount: 1 }))).toBe(false);
  expect(isGroupChat(channel("old-server"))).toBe(false);
  expect(isGroupChat(channel("no-people-yet", { memberCount: 0 }))).toBe(false);
});

test("every conversation is placed once, and a filed one is not under Group or Direct", () => {
  /*
   * The whole point of a folder: the conversation stops being drawn twice. Counts are asserted
   * rather than membership alone, because a channel that lands in both its folder and its old
   * section is exactly the bug this section of the sidebar exists to remove.
   */
  const sections = conversationSections(
    [
      channel("group-1", { memberCount: 3 }),
      channel("direct-1"),
      channel("filed-1", { memberCount: 3, projectId: "p-1" }),
    ],
    [project("p-1", "Website redesign")],
  );

  expect(sections.group.map((c) => c.id)).toEqual(["group-1"]);
  expect(sections.direct.map((c) => c.id)).toEqual(["direct-1"]);
  expect(sections.projects.map((folder) => folder.project.id)).toEqual(["p-1"]);
  expect(sections.projects[0]?.channels.map((c) => c.id)).toEqual(["filed-1"]);
  expect(sectionConversationCount(sections, "group")).toBe(1);
  expect(sectionConversationCount(sections, "direct")).toBe(1);
  expect(sectionConversationCount(sections, "projects")).toBe(1);
});

test("a conversation naming a folder that is gone falls back to its own shape", () => {
  /*
   * Reachable without anybody doing anything wrong: a folder deleted in another tab, or a roster
   * read that outran the projects read. A conversation nobody can find is worse than one sitting in
   * the section it used to be in, so the row is placed by shape instead of disappearing.
   */
  const sections = conversationSections(
    [
      channel("orphan-group", { memberCount: 2, projectId: "p-deleted" }),
      channel("orphan-direct", { projectId: "p-deleted" }),
    ],
    [project("p-1", "Website redesign")],
  );

  expect(sections.group.map((c) => c.id)).toEqual(["orphan-group"]);
  expect(sections.direct.map((c) => c.id)).toEqual(["orphan-direct"]);
  expect(sections.projects[0]?.channels).toEqual([]);
});

test("the roster's order is kept inside a section, and folders keep the person's order", () => {
  /*
   * The roster arrives in the order the sidebar draws — pinned first, then most recent activity —
   * and a folder list arrives in the owner's own sort order. Re-sorting here would fight both, so
   * this holds the input order rather than restoring it.
   */
  const sections = conversationSections(
    [
      channel("recent", { memberCount: 2 }),
      channel("older", { memberCount: 2 }),
      channel("oldest", { memberCount: 2 }),
      channel("filed-late", { projectId: "p-2" }),
      channel("filed-early", { projectId: "p-1" }),
    ],
    [project("p-1", "First"), project("p-2", "Second")],
  );

  expect(sections.group.map((c) => c.id)).toEqual([
    "recent",
    "older",
    "oldest",
  ]);
  expect(sections.projects.map((folder) => folder.project.name)).toEqual([
    "First",
    "Second",
  ]);
  expect(sections.projects[0]?.channels.map((c) => c.id)).toEqual([
    "filed-early",
  ]);
  expect(sections.projects[1]?.channels.map((c) => c.id)).toEqual([
    "filed-late",
  ]);
});

test("a section with nothing to read is empty rather than absent", () => {
  /*
   * Both reads can still be in flight, and the sidebar draws the same three headers either way. An
   * undefined roster is an empty sidebar, not a thrown render.
   */
  const sections = conversationSections(undefined, undefined);

  expect(sections.group).toEqual([]);
  expect(sections.direct).toEqual([]);
  expect(sections.projects).toEqual([]);
  expect(sectionConversationCount(sections, "projects")).toBe(0);
});

test("the Projects header counts what is filed across all folders", () => {
  const sections = conversationSections(
    [
      channel("a", { projectId: "p-1" }),
      channel("b", { projectId: "p-1" }),
      channel("c", { projectId: "p-2" }),
    ],
    [project("p-1", "One"), project("p-2", "Two")],
  );

  expect(sectionConversationCount(sections, "projects")).toBe(3);
});

test("an absent fold flag reads as open, so a new section is never born folded", () => {
  /*
   * The stored object is what is *folded*. A person who has folded nothing has no flags, and a row
   * written by a build that knew fewer sections carries no flag for the one it did not know — both
   * have to draw open, or a section arrives already shut with no way to tell why.
   */
  expect(mergeSidebarSections(undefined)).toEqual(OPEN);
  expect(mergeSidebarSections({ direct: true })).toEqual({
    group: false,
    direct: true,
    projects: false,
  });
});

test("a header click flips its own section and hands back the whole set", () => {
  /*
   * The save sends the whole object, so a toggle that returned only the changed flag would write
   * the other two away. This is the one place that is checked.
   */
  const folded = toggledSidebarSection(OPEN, "direct");

  expect(folded).toEqual({ group: false, direct: true, projects: false });
  expect(toggledSidebarSection(folded, "direct")).toEqual(OPEN);
  expect(toggledSidebarSection(OPEN, "projects")).toEqual({
    group: false,
    direct: false,
    projects: true,
  });
});

test("a search opens every section and leaves the chosen fold in place", () => {
  /*
   * A match inside a folded section is a result the person would be told about and not shown. The
   * fold is drawn over, not written: clearing the box has to bring back what they chose, not the
   * all-open state the search needed.
   */
  const chosen: SidebarSections = {
    group: true,
    direct: false,
    projects: true,
  };

  expect(collapsedSections(chosen, true)).toEqual(OPEN);
  expect(collapsedSections(chosen, false)).toEqual(chosen);
});

test("a folded section is still drawn, and an empty one is dropped only while searching", () => {
  /*
   * The header is how a folded section is opened again, so folding never removes it. An empty one
   * is dropped while searching: "No group chats yet" beside a box full of a colleague's name is the
   * wrong sentence about the wrong thing.
   */
  expect(sectionVisible(0, false)).toBe(true);
  expect(sectionVisible(3, false)).toBe(true);
  expect(sectionVisible(3, true)).toBe(true);
  expect(sectionVisible(0, true)).toBe(false);
});

test("the move menu offers every folder but the current one, then the way to make one", () => {
  /*
   * The current folder is left out rather than drawn disabled: moving something to where it already
   * is is not an action, and the menu already carries "Remove from project" for the way back out.
   * "New project…" is always last, and is the only row a person with no folders sees.
   */
  const folders = [project("p-1", "One"), project("p-2", "Two")];

  expect(moveToProjectOffers(folders, null)).toEqual([
    { kind: "project", projectId: "p-1", name: "One" },
    { kind: "project", projectId: "p-2", name: "Two" },
    { kind: "new" },
  ]);
  expect(moveToProjectOffers(folders, "p-1")).toEqual([
    { kind: "project", projectId: "p-2", name: "Two" },
    { kind: "new" },
  ]);
  expect(moveToProjectOffers(undefined, null)).toEqual([{ kind: "new" }]);
});
