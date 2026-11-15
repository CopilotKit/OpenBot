import { expect, test } from "bun:test";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  filterRoster,
  groupRoster,
  type RosterFilters,
} from "@/lib/agents/roster";

function bot(overrides: Partial<AgentProfile> & { id: string }): AgentProfile {
  return {
    assignedToMe: false,
    runsOnOpenBotModel: false,
    keyFromOpenBot: false,
    name: overrides.id,
    title: "Title",
    roleDescription: "Role",
    avatarSeed: "seed",
    visibility: "private",
    endpoint: null,
    builtIn: true,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
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

const defaults: RosterFilters = { query: "", scope: "all", sort: "default" };
const roster = [
  bot({
    id: "z",
    name: "Zoe",
    title: "Analyst",
    roleDescription: "Reviews invoices",
    mine: true,
  }),
  bot({
    id: "a",
    name: "Ada",
    title: "Writer",
    roleDescription: "Drafts reports",
    canManage: true,
  }),
  bot({
    id: "b",
    name: "Bot 2",
    title: "Assistant",
    roleDescription: "Reviews budgets",
    assignedToMe: true,
  }),
  bot({
    id: "c",
    name: "Bot 10",
    title: "Assistant",
    roleDescription: "",
    pinned: true,
    mine: true,
  }),
];

test("search ignores case and outer whitespace across name, title and description", () => {
  for (const [query, expected] of [
    ["  ZOE ", ["z"]],
    ["writer", ["a"]],
    ["invoices", ["z"]],
    ["   ", ["z", "a", "b", "c"]],
    ["absent", []],
  ] as const) {
    expect(ids(filterRoster(roster, { ...defaults, query }))).toEqual([
      ...expected,
    ]);
  }
});

test("search AND scope uses ownership rather than administrator management permission", () => {
  expect(ids(filterRoster(roster, { ...defaults, scope: "yours" }))).toEqual([
    "z",
    "c",
  ]);
  expect(ids(filterRoster(roster, { ...defaults, scope: "shared" }))).toEqual([
    "a",
    "b",
  ]);
  expect(
    ids(filterRoster(roster, { ...defaults, scope: "pinned", query: "bot" })),
  ).toEqual(["b", "c"]);
  expect(
    ids(filterRoster(roster, { ...defaults, scope: "yours", query: "writer" })),
  ).toEqual([]);
});

test("sorts names naturally, titles and descriptions both ways without mutating the query cache", () => {
  const order = ids(roster);
  for (const [sort, expected] of [
    ["name-asc", ["a", "b", "c", "z"]],
    ["name-desc", ["z", "c", "b", "a"]],
    ["title-asc", ["z", "b", "c", "a"]],
    ["title-desc", ["a", "b", "c", "z"]],
    ["description-asc", ["c", "a", "b", "z"]],
    ["description-desc", ["z", "b", "a", "c"]],
  ] as const) {
    expect(ids(filterRoster(roster, { ...defaults, sort }))).toEqual([
      ...expected,
    ]);
    expect(ids(roster)).toEqual(order);
  }
});

test("search uses the same framework name the roster displays", () => {
  const bots = [bot({ id: "legacy", title: "Powered by LangGraph" })];
  // The displayed subtitle normalizer is also used by the roster's search.
  expect(ids(filterRoster(bots, { ...defaults, query: "LangChain" }))).toEqual(
    ["legacy"],
  );
});
