import { afterEach, describe, expect, test } from "bun:test";
import { setEdition } from "../src/edition";
import {
  ensureAlwaysOnApp,
  isAlwaysOn,
  withPersonalDefaults,
} from "../src/plugins/personal-defaults";

type Tool = { ref: string };

const ROUTINES: Tool[] = [
  { ref: "routines/list_routines" },
  { ref: "routines/create_routine" },
];
const NOTION: Tool[] = [
  { ref: "notion/search" },
  { ref: "notion/create_page" },
];

/**
 * A store whose apps list whatever the test says each vendor answers. `vendors` is what an app
 * lists the next time it is refreshed; `added` is what the deployment has added so far.
 */
function fakeStore(vendors: Record<string, Tool[]>) {
  const listed = new Map<string, Tool[]>();
  const grants: string[] = [];
  /** Who the trail names for each grant, by `agent:ref`. */
  const grantedBy = new Map<string, string>();
  const added: string[] = [];
  const store = {
    async refreshTools(serverId: string, _actorId = "") {
      listed.set(serverId, vendors[serverId] ?? []);
      return { tools: listed.get(serverId)?.length ?? 0 };
    },
    async grant(
      _kind: "mcp",
      ref: string,
      agentId: string,
      by: string,
      _as: "admin" | "owner" = "admin",
    ) {
      grants.push(`${agentId}:${ref}`);
      grantedBy.set(`${agentId}:${ref}`, by);
    },
    /** Methods call each other through `this`, as the real store's do. */
    async addServer(input: { key: string; by: string }) {
      added.push(input.key);
      await this.refreshTools(input.key);
    },
    async serverAddress(serverId: string) {
      return added.includes(serverId) ? { id: serverId } : undefined;
    },
    async listForAgent(agentId: string) {
      return grants.filter((grant) => grant.startsWith(`${agentId}:`));
    },
  };
  const deps = {
    tools: async (serverId: string) => listed.get(serverId) ?? [],
    bots: async () => ["assistant", "researcher"],
    granted: async (agentId: string, serverId: string) =>
      new Set(
        grants
          .filter((grant) => grant.startsWith(`${agentId}:${serverId}/`))
          .map((grant) => grant.slice(agentId.length + 1)),
      ),
    servers: async () => added,
  };
  const wrapped = withPersonalDefaults(store, deps);
  return { store: wrapped, grants, grantedBy, added, deps };
}

afterEach(() => setEdition("team"));

describe("a connected app in the personal edition", () => {
  test("gives every Bot every tool, including the ones that change things", async () => {
    setEdition("personal");
    const { store, grants } = fakeStore({ notion: NOTION });
    await store.addServer({ key: "notion", by: "me" });
    expect(grants.sort()).toEqual([
      "assistant:notion/create_page",
      "assistant:notion/search",
      "researcher:notion/create_page",
      "researcher:notion/search",
    ]);
  });

  test("a refresh gives only what a Bot doesn't hold yet", async () => {
    setEdition("personal");
    const { store, grants } = fakeStore({ notion: NOTION });
    await store.addServer({ key: "notion", by: "me" });
    const before = grants.length;
    await store.refreshTools("notion");
    expect(grants).toHaveLength(before);
  });

  test("a Bot made later gets every connected app the first time it runs", async () => {
    setEdition("personal");
    const { store, deps } = fakeStore({ notion: NOTION, routines: ROUTINES });
    await ensureAlwaysOnApp(store, deps);
    await store.addServer({ key: "notion", by: "me" });
    expect((await store.listForAgent("travel")).sort()).toEqual([
      "travel:notion/create_page",
      "travel:notion/search",
      "travel:routines/create_routine",
      "travel:routines/list_routines",
    ]);
  });

  test("the trail says why a Bot made later holds each app", async () => {
    setEdition("personal");
    const { store, deps, grantedBy } = fakeStore({
      notion: NOTION,
      routines: ROUTINES,
    });
    await ensureAlwaysOnApp(store, deps);
    await store.addServer({ key: "notion", by: "me" });
    await store.listForAgent("travel");
    expect(grantedBy.get("travel:notion/search")).toBe(
      "openbot:personal-defaults",
    );
    expect(grantedBy.get("travel:routines/list_routines")).toBe(
      "openbot:always-on",
    );
  });
});

test("the team edition gives nothing for an app an admin adds", async () => {
  const { store, grants } = fakeStore({ notion: NOTION });
  await store.addServer({ key: "notion", by: "me" });
  expect(grants).toEqual([]);
  expect(await store.listForAgent("assistant")).toEqual([]);
});

describe("Routines, in every edition", () => {
  test("is added at startup and every Bot gets all its tools, including ones that change things", async () => {
    setEdition("personal");
    const { store, grants, added, deps } = fakeStore({ routines: ROUTINES });
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
    const { store, grants, added, deps } = fakeStore({ routines: ROUTINES });
    await ensureAlwaysOnApp(store, deps);
    const before = grants.length;
    await ensureAlwaysOnApp(store, deps);
    expect(added).toEqual(["routines"]);
    expect(grants).toHaveLength(before);
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
    const { store, grants, added, deps } = fakeStore({ routines: ROUTINES });
    await ensureAlwaysOnApp(store, deps);
    expect(added).toEqual(["routines"]);
    expect(grants).toHaveLength(4);
    expect(await store.listForAgent("travel")).toHaveLength(2);
  });
});
