import { expect, test } from "bun:test";
import {
  createIntelligenceMemory,
  type IntelligenceMemoryClient,
} from "../src/memory/intelligence";

function client(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const base = {
    async getRuntimeEntitlements() {
      calls.push("entitlements");
      return {
        status: "ready",
        entitlement: {
          active: true,
          source: "managedOrgSubscription",
          features: { memory: true },
          limits: {},
        },
      };
    },
    async listMemories() {
      calls.push("list");
      return {
        memories: [
          {
            id: "a",
            kind: "topical",
            scope: "user",
            content: "mine",
            sourceThreadIds: [],
            invalidatedAt: null,
          },
          {
            id: "p",
            kind: "topical",
            scope: "project",
            content: "everyone's",
            sourceThreadIds: [],
            invalidatedAt: null,
          },
        ],
      };
    },
    async createMemory() {
      calls.push("create");
      return {
        id: "new",
        kind: "topical",
        scope: "user",
        content: "x",
        sourceThreadIds: [],
        invalidatedAt: null,
      };
    },
    async updateMemory() {
      calls.push("update");
      throw Object.assign(new Error("gone"), { status: 404 });
    },
    async removeMemory() {
      calls.push("remove");
    },
    async recallMemories() {
      calls.push("recall");
      return { memories: [] };
    },
    ...overrides,
  };
  return { calls, client: base as unknown as IntelligenceMemoryClient };
}

test("project-scoped memories are dropped even when the platform returns them", async () => {
  const { client: fake } = client();
  const memory = createIntelligenceMemory({ client: fake, log: () => {} });
  expect((await memory.list("ada"))?.map((m) => m.id)).toEqual(["a"]);
});

test("not entitled: no memory call is made and every answer is empty", async () => {
  const { client: fake, calls } = client({
    async getRuntimeEntitlements() {
      calls.push("entitlements");
      return {
        status: "ready",
        entitlement: {
          active: true,
          source: "managedOrgSubscription",
          features: { memory: false },
          limits: {},
        },
      };
    },
  });
  const memory = createIntelligenceMemory({ client: fake, log: () => {} });
  expect(await memory.available()).toBe(false);
  expect(await memory.list("ada")).toBeUndefined();
  expect(await memory.create("ada", "x")).toBeUndefined();
  expect(calls.filter((call) => call !== "entitlements")).toEqual([]);
});

test("a 403 holds memory on the local store for a minute, then asks again", async () => {
  let clock = 0;
  let denied = true;
  const { client: fake, calls } = client({
    async listMemories() {
      calls.push("list");
      if (denied) throw Object.assign(new Error("denied"), { status: 403 });
      return { memories: [] };
    },
  });
  const memory = createIntelligenceMemory({
    client: fake,
    now: () => clock,
    log: () => {},
  });
  expect(await memory.list("ada")).toBeUndefined();
  denied = false;
  clock += 30_000;
  expect(await memory.list("ada")).toBeUndefined();
  expect(calls.filter((call) => call === "list")).toHaveLength(1);
  clock += 31_000;
  expect(await memory.list("ada")).toEqual([]);
});

test("a person's list is reused for a moment and cleared by their own write", async () => {
  let clock = 0;
  const { client: fake, calls } = client();
  const memory = createIntelligenceMemory({
    client: fake,
    now: () => clock,
    log: () => {},
  });
  await memory.list("ada");
  await memory.list("ada");
  expect(calls.filter((call) => call === "list")).toHaveLength(1);
  await memory.create("ada", "new fact");
  await memory.list("ada");
  expect(calls.filter((call) => call === "list")).toHaveLength(2);
  clock += 31_000;
  await memory.list("ada");
  expect(calls.filter((call) => call === "list")).toHaveLength(3);
});

test("superseding a memory that is already retired says so", async () => {
  const { client: fake } = client();
  const memory = createIntelligenceMemory({ client: fake, log: () => {} });
  expect(await memory.supersede("ada", "old", "new")).toBe("gone");
});
