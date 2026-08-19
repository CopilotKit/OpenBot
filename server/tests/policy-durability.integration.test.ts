import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "../src/computer/policy-store";
import { createDatabase } from "../src/db/client";
import { TEST_POOL } from "./support/database";
import { actionPolicy } from "../src/db/schema";

/**
 * The boundary has to survive a restart.
 *
 * A policy held only in memory means a rule an administrator adds is gone the next time the process
 * comes up, and nothing says so. The persisted row is the contract that keeps the boundary active
 * across process replacement.
 *
 * A restart is simulated by building a second store, which is what a restart is from this module's
 * point of view: a fresh process, the same configured default, the same database. Asserting through
 * one store would only prove it remembers what it was told a moment ago.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const configured = DEFAULT_ACTION_POLICY;
const rule = 'intent == "activate" && contains(element.name, "submit")';

afterEach(async () => {
  await database.delete(actionPolicy).where(eq(actionPolicy.id, "current"));
});

describe("a boundary set while running", () => {
  test("is still there after a restart", async () => {
    const before = createPolicyStore(configured, database);
    await before.load();
    await before.set(
      { mode: "enforce", deny: [rule], ask: [], allow: ["true"] },
      "admin@example.test",
    );

    const after = createPolicyStore(configured, database);
    expect(await after.load()).toBe("the database");
    expect(after.get().deny).toEqual([rule]);
  });

  test("the rules that ask a person survive a restart too", async () => {
    // The list that stops and asks has to be as durable as the one that refuses. A boundary that
    // silently stopped asking after a deployment came back up would be indistinguishable, from the
    // trail, from one whose questions were all answered yes.
    const asking = 'intent == "write_file" && !matches(file.path, "^notes/")';
    const before = createPolicyStore(configured, database);
    await before.set({
      mode: "enforce",
      deny: [],
      ask: [asking],
      allow: ["true"],
    });

    const after = createPolicyStore(configured, database);
    expect(await after.load()).toBe("the database");
    expect(after.get().ask).toEqual([asking]);
  });

  test("a deployment that never set one gets its configured default", async () => {
    const store = createPolicyStore(configured, database);
    expect(await store.load()).toBe("configuration");
    expect(store.get()).toEqual(configured);
  });

  test("resetting forgets it, so a restart returns to configuration", async () => {
    const store = createPolicyStore(configured, database);
    await store.set({
      mode: "enforce",
      deny: [rule],
      ask: [],
      allow: ["true"],
    });
    await store.reset();

    // The saved row is removed rather than overwritten, so changing what configuration says then
    // changes what is enforced, which is what an operator expects a reset to mean.
    const after = createPolicyStore(configured, database);
    expect(await after.load()).toBe("configuration");
    expect(after.get().deny).toEqual([]);
  });

  test("setting twice keeps one row and the latest rule", async () => {
    const store = createPolicyStore(configured, database);
    await store.set({
      mode: "enforce",
      deny: ["first"],
      ask: [],
      allow: ["true"],
    });
    await store.set({
      mode: "dry-run",
      deny: ["second"],
      ask: [],
      allow: ["true"],
    });

    const rows = await database.select().from(actionPolicy);
    // One boundary per deployment, by construction. Two rows would mean something has to choose.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mode).toBe("dry-run");
    expect(rows[0]?.deny).toEqual(["second"]);
  });

  test("records who changed it", async () => {
    const store = createPolicyStore(configured, database);
    await store.set(
      { mode: "enforce", deny: [rule], ask: [], allow: ["true"] },
      "admin@example.test",
    );

    const [row] = await database.select().from(actionPolicy);
    expect(row?.updatedBy).toBe("admin@example.test");
  });

  test("without a database it still works, in memory", async () => {
    // A test about the decision logic must not need Postgres, and a deployment with no database has
    // bigger problems than an unsaved rule.
    const store = createPolicyStore(configured);
    expect(await store.load()).toBe("configuration");
    await store.set({
      mode: "enforce",
      deny: [rule],
      ask: [],
      allow: ["true"],
    });
    expect(store.get().deny).toEqual([rule]);
    await store.reset();
    expect(store.get()).toEqual(configured);
  });
});
