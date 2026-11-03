import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createApprovalStore } from "../src/approvals/store";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { setEdition } from "../src/edition";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `approval-edition-${randomUUID()}`;
const fresh = `${prefix}-fresh`,
  chose = `${prefix}-chose`;
const store = createApprovalStore(database);
const { policy } = store;

beforeAll(async () => {
  await database.insert(users).values([
    { id: fresh, email: `${fresh}@example.test` },
    { id: chose, email: `${chose}@example.test` },
  ]);
});
afterEach(() => setEdition("team"));
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [fresh, chose]));
  await database.$client.close();
});

test("the personal edition asks first for somebody who has chosen nothing", async () => {
  setEdition("personal");
  expect(await policy.preferences(fresh)).toEqual({
    enabled: true,
    autoReview: false,
    hostCommands: "ask",
  });
});

test("the team edition does not", async () => {
  expect((await policy.preferences(fresh)).enabled).toBe(false);
});

test("a saved choice beats the personal edition's default", async () => {
  setEdition("personal");
  await policy.setPreferences(chose, { enabled: false });
  expect((await policy.preferences(chose)).enabled).toBe(false);
  expect(await store.enabled(chose)).toBe(false);
});

// The switch on Settings → Approvals reads this; it must say what the policy above decides.
test("the personal edition's switch shows asking first as on for somebody who chose nothing", async () => {
  setEdition("personal");
  expect(await store.enabled(fresh)).toBe(true);
  setEdition("team");
  expect(await store.enabled(fresh)).toBe(false);
});

/** A database that fails the test if the personal edition reads a stored value at all. */
const untouchable = new Proxy({} as typeof database, {
  get: (_target, property) => {
    throw new Error(
      `the personal edition read the database (${String(property)})`,
    );
  },
});

// A team deployment's settings and rules have no screen in the personal edition, so they are not read.
test("the personal edition ignores team approval settings and team rules", async () => {
  setEdition("personal");
  const { policy: personal } = createApprovalStore(untouchable);
  expect(await personal.teamSettings()).toEqual({
    enforceAutoReview: false,
    customRulesEnabled: true,
    hostCommandsCap: "allow",
  });
  expect(await personal.teamRules()).toEqual([]);
});
