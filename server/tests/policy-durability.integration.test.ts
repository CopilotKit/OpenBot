import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "../src/computer/policy-store";
import { createDatabase } from "../src/db/client";
import { actionPolicy } from "../src/db/schema";
import type { PolicyCache } from "../src/policy/cache";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  createTestPolicyCache,
  resetTestPolicy,
  useTestPolicy,
} from "./support/policy";

/**
 * The boundary has to survive a restart.
 *
 * A policy held only in memory means a rule an administrator adds is gone the next time the process
 * comes up, and nothing says so. The boundary saved in Intelligence's organization policy is the
 * contract that keeps it active across process replacement.
 *
 * A restart is simulated by building a second store on a policy cache of its own, which is what a
 * restart is from this module's point of view: a fresh process, the same configured default, the same
 * Intelligence. Asserting through one store would only prove it remembers what it was told a moment ago.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const configured = DEFAULT_ACTION_POLICY;
const rule = 'intent == "activate" && contains(element.name, "submit")';

let cache: PolicyCache;

/** A restart: a process that reads the policy from Intelligence afresh. */
async function restarted() {
  const fresh = createTestPolicyCache({ subscribe: false });
  await fresh.start();
  fresh.stop();
  return createPolicyStore(configured, fresh);
}

beforeAll(async () => {
  cache = await useTestPolicy();
  await resetTestPolicy();
});

afterEach(async () => {
  await resetTestPolicy();
});

describe("a boundary set while running", () => {
  test("is still there after a restart", async () => {
    const before = createPolicyStore(configured, cache);
    await before.load();
    await before.set(
      { mode: "enforce", deny: [rule], allow: ["true"] },
      "admin@example.test",
    );

    const after = await restarted();
    expect(await after.load()).toBe("intelligence");
    expect(after.get().deny).toEqual([rule]);
  });

  test("keeps each rule's name and description across a restart", async () => {
    const before = createPolicyStore(configured, cache);
    await before.load();
    const labels = {
      [rule]: { name: "Never submit a form", description: "Stops submits." },
    };
    await before.set({
      mode: "enforce",
      deny: [rule],
      allow: ["true"],
      labels,
    });

    const after = await restarted();
    await after.load();
    expect(after.get().labels).toEqual(labels);
  });

  test("a deployment that never set one gets its configured default", async () => {
    const store = await restarted();
    expect(await store.load()).toBe("configuration");
    expect(store.get()).toEqual(configured);
  });

  test("resetting forgets it, so a restart returns to configuration", async () => {
    const store = createPolicyStore(configured, cache);
    await store.set({ mode: "enforce", deny: [rule], allow: ["true"] });
    await store.reset();

    // The saved boundary is cleared rather than overwritten with the configured one, so changing
    // what configuration says then changes what is enforced, which is what an operator expects.
    const after = await restarted();
    expect(await after.load()).toBe("configuration");
    expect(after.get().deny).toEqual([]);
    expect((await cache.client.actionBoundary()).boundary).toBeNull();
  });

  test("setting twice keeps one boundary and the latest rule", async () => {
    const store = createPolicyStore(configured, cache);
    await store.set({ mode: "enforce", deny: ["first"], allow: ["true"] });
    await store.set({ mode: "dry-run", deny: ["second"], allow: ["true"] });

    // One boundary per deployment, by construction. Two would mean something has to choose.
    const saved = await cache.client.actionBoundary();
    expect(saved.boundary?.mode).toBe("dry-run");
    expect(saved.boundary?.deny).toEqual(["second"]);
  });

  test("records who changed it", async () => {
    const store = createPolicyStore(configured, cache);
    await store.set(
      { mode: "enforce", deny: [rule], allow: ["true"] },
      "admin@example.test",
    );

    expect((await cache.client.actionBoundary()).updatedBy).toBe(
      "admin@example.test",
    );
  });

  test("is written to Intelligence and never to this deployment's own table", async () => {
    // The local table is kept for one release so an upgrade can copy it; nothing writes it any more.
    const store = createPolicyStore(configured, cache);
    await store.set({ mode: "enforce", deny: [rule], allow: ["true"] });
    expect(await database.select().from(actionPolicy)).toHaveLength(0);
  });

  test("a boundary Intelligence refuses is not enforced, and the store says so", async () => {
    // The administrator must hear that the rule was not saved, not see it enforced until a restart.
    const store = createPolicyStore(configured, cache);
    await expect(
      store.set({
        mode: "enforce",
        deny: Array.from({ length: 1_001 }, (_, index) => `rule ${index}`),
        allow: ["true"],
      }),
    ).rejects.toThrow();
    expect(store.get()).toEqual(configured);
  });

  test("without Intelligence it still works, in memory", async () => {
    // A test about the decision logic must not need Intelligence.
    const store = createPolicyStore(configured);
    expect(await store.load()).toBe("configuration");
    await store.set({ mode: "enforce", deny: [rule], allow: ["true"] });
    expect(store.get().deny).toEqual([rule]);
    await store.reset();
    expect(store.get()).toEqual(configured);
  });
});

afterAll(async () => {
  await database.$client.close();
});
