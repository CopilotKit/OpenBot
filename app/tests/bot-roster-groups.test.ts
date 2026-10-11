import { expect, test } from "bun:test";
import type { AgentProfile } from "@/lib/agents/queries";
import { groupRoster } from "@/lib/agents/roster";

function bot(overrides: Partial<AgentProfile> & { id: string }): AgentProfile {
  return {
    name: overrides.id,
    title: "Title",
    roleDescription: "Role",
    avatarSeed: "seed",
    visibility: "private",
    endpoint: null,
    builtIn: true,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    pinned: false,
    systemOwned: false,
    canManage: false,
    mine: false,
    ...overrides,
  };
}

const ids = (list: AgentProfile[]) => list.map((agent) => agent.id);

test("your own Bots are Yours and everyone else's are Shared with you", () => {
  const groups = groupRoster([
    bot({ id: "mine", mine: true, canManage: true }),
    bot({ id: "public", visibility: "public" }),
    bot({ id: "team" }),
  ]);
  expect(ids(groups.yours)).toEqual(["mine"]);
  expect(ids(groups.shared)).toEqual(["public", "team"]);
  expect(groups.pinned).toEqual([]);
});

test("an administrator's Yours holds only the Bots they created", () => {
  const groups = groupRoster([
    bot({ id: "theirs", mine: true, canManage: true }),
    bot({ id: "colleague", canManage: true }),
  ]);
  expect(ids(groups.yours)).toEqual(["theirs"]);
  expect(ids(groups.shared)).toEqual(["colleague"]);
});

test("a pinned Bot is in Pinned only, wherever it would otherwise sit", () => {
  const groups = groupRoster([
    bot({ id: "mine", mine: true, pinned: true }),
    bot({ id: "shared", pinned: true }),
  ]);
  expect(ids(groups.pinned)).toEqual(["mine", "shared"]);
  expect(groups.yours).toEqual([]);
  expect(groups.shared).toEqual([]);
});

test("a Team Bot an administrator assigned to the person is always pinned", () => {
  const groups = groupRoster([bot({ id: "assigned", assignedToMe: true })]);
  expect(ids(groups.pinned)).toEqual(["assigned"]);
  expect(groups.shared).toEqual([]);
});

test("a Bot waiting on the person is in Needs you only, ahead of every other section", () => {
  const waiting = new Set(["pinned-waiting", "mine-waiting"]);
  const groups = groupRoster(
    [
      bot({ id: "pinned-waiting", pinned: true }),
      bot({ id: "mine-waiting", mine: true }),
      bot({ id: "quiet", mine: true }),
    ],
    (id) => (waiting.has(id) ? 1 : 0),
  );
  expect(ids(groups.needsYou)).toEqual(["pinned-waiting", "mine-waiting"]);
  expect(groups.pinned).toEqual([]);
  expect(ids(groups.yours)).toEqual(["quiet"]);
});
