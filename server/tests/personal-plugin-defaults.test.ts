import { afterEach, describe, expect, test } from "bun:test";
import { setEdition } from "../src/edition";
import { withPersonalDefaults } from "../src/plugins/personal-defaults";

type Tool = { ref: string; read: boolean };

/** A store whose listing is whatever the test says the vendor answered this time. */
function fakeStore(listings: Tool[][]) {
  let listed: Tool[] = [];
  const grants: string[] = [];
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
    async addServer(serverId: string) {
      await this.refreshTools(serverId);
    },
  };
  const wrapped = withPersonalDefaults(store, {
    tools: async () => listed,
    bots: async () => ["assistant", "researcher"],
  });
  return { store: wrapped, grants };
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
