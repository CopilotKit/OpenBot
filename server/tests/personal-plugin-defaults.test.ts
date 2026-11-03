import { afterEach, describe, expect, test } from "bun:test";
import { setEdition } from "../src/edition";
import {
  ensureAlwaysOnApp,
  isAlwaysOn,
  withPersonalDefaults,
} from "../src/plugins/personal-defaults";

type Tool = { ref: string; read: boolean };

/** A store whose listing is whatever the test says the vendor answered this time. */
function fakeStore(listings: Tool[][]) {
  let listed: Tool[] = [];
  const grants: string[] = [];
  const added: string[] = [];
  const store = {
    async refreshTools(_serverId: string, _actorId = "") {
      listed = listings.shift() ?? listed;
      return { tools: listed.length };
    },
    async grant(
      _kind: "mcp",
      ref: string,
      agentId: string,
      _by: string,
      _as: "admin" | "owner" = "admin",
    ) {
      grants.push(`${agentId}:${ref}`);
    },
    /** Methods call each other through `this`, as the real store's do. */
    async addServer(input: { key: string; by: string } | string) {
      const key = typeof input === "string" ? input : input.key;
      added.push(key);
      await this.refreshTools(key);
    },
    async serverAddress(serverId: string) {
      return added.includes(serverId) ? { id: serverId } : undefined;
    },
    async listForAgent(agentId: string) {
      return grants.filter((grant) => grant.startsWith(`${agentId}:`));
    },
  };
  const deps = {
    tools: async () => listed,
    bots: async () => ["assistant", "researcher"],
    granted: async (agentId: string) =>
      new Set(
        grants
          .filter((grant) => grant.startsWith(`${agentId}:`))
          .map((grant) => grant.slice(agentId.length + 1)),
      ),
  };
  const wrapped = withPersonalDefaults(store, deps);
  return { store: wrapped, grants, added, deps };
}

afterEach(() => setEdition("team"));

describe("a newly connected app in the personal edition", () => {
  test("gives every Bot its read-only tools, and none that change things", async () => {
    setEdition("personal");
    const { store, grants } = fakeStore([
      [
        { ref: "notion/search", read: true },
        { ref: "notion/create_page", read: false },
      ],
    ]);
    await store.refreshTools("notion");
    expect(grants.sort()).toEqual([
      "assistant:notion/search",
      "researcher:notion/search",
    ]);
  });

  test("does it when the listing happens inside another store method", async () => {
    setEdition("personal");
    const { store, grants } = fakeStore([
      [{ ref: "notion/search", read: true }],
    ]);
    await store.addServer("notion");
    expect(grants).toHaveLength(2);
  });

  test("gives only tools that are new, so a refresh never undoes a choice", async () => {
    setEdition("personal");
    const { store, grants } = fakeStore([
      [{ ref: "notion/search", read: true }],
      [
        { ref: "notion/search", read: true },
        { ref: "notion/get_page", read: true },
      ],
    ]);
    await store.refreshTools("notion");
    grants.length = 0;
    await store.refreshTools("notion");
    expect(grants.sort()).toEqual([
      "assistant:notion/get_page",
      "researcher:notion/get_page",
    ]);
  });
});

test("the team edition gives nothing by default", async () => {
  const { store, grants } = fakeStore([[{ ref: "notion/search", read: true }]]);
  await store.refreshTools("notion");
  expect(grants).toEqual([]);
});

describe("Routines, in every edition", () => {
  const routines = () => [
    [
      { ref: "routines/list_routines", read: true },
      { ref: "routines/create_routine", read: false },
    ],
  ];

  test("is added at startup and every Bot gets all its tools, including ones that change things", async () => {
    setEdition("personal");
    const { store, grants, added, deps } = fakeStore(routines());
    await ensureAlwaysOnApp(store, deps);
    expect(added).toEqual(["routines"]);
    expect(grants.sort()).toEqual([
      "assistant:routines/create_routine",
      "assistant:routines/list_routines",
      "researcher:routines/create_routine",
      "researcher:routines/list_routines",
    ]);
  });

  test("a second startup writes nothing", async () => {
    setEdition("personal");
    const { store, grants, added, deps } = fakeStore(routines());
    await ensureAlwaysOnApp(store, deps);
    const before = grants.length;
    await ensureAlwaysOnApp(store, deps);
    expect(added).toEqual(["routines"]);
    expect(grants).toHaveLength(before);
  });

  test("a Bot made later gets it the first time it runs", async () => {
    setEdition("personal");
    const { store, grants, deps } = fakeStore(routines());
    await ensureAlwaysOnApp(store, deps);
    expect(await store.listForAgent("travel")).toEqual([
      "travel:routines/list_routines",
      "travel:routines/create_routine",
    ]);
    expect(grants.filter((grant) => grant.startsWith("travel:"))).toHaveLength(
      2,
    );
  });

  test("cannot be turned off or taken from a Bot", () => {
    setEdition("personal");
    expect(isAlwaysOn("routines")).toBe(true);
    expect(isAlwaysOn("routines/create_routine")).toBe(true);
    expect(isAlwaysOn("notion")).toBe(false);
    setEdition("team");
    expect(isAlwaysOn("routines")).toBe(true);
  });

  test("the team edition adds it and gives every Bot all its tools too", async () => {
    const { store, grants, added, deps } = fakeStore(routines());
    await ensureAlwaysOnApp(store, deps);
    expect(added).toEqual(["routines"]);
    expect(grants).toHaveLength(4);
    expect(await store.listForAgent("travel")).toHaveLength(2);
  });
});
