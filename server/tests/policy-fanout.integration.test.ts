import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { startPolicyListener } from "../src/computer/policy-listener";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "../src/computer/policy-store";
import { createDatabase } from "../src/db/client";
import { actionPolicy } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * A boundary an administrator changes has to reach every server, not the one that served the request.
 *
 * OpenBot runs several servers behind a load balancer. The policy is read from memory on every single
 * action, which is right: a query per keystroke would be absurd. What was wrong is that memory was
 * only ever filled at boot, so a new deny rule applied on the one server that happened to receive it
 * and nowhere else. The admin screen reported success, because the row really was saved, and the
 * audit trail agreed, because it records the boundary each process started with. Both were honest and
 * both were describing something other than what the fleet was enforcing.
 *
 * A deny rule that stops roughly one action in N is worse than no deny rule at all: it looks like it
 * works, so nobody goes looking.
 *
 * Another server is simulated by a second store on the same database with its own listener, the way
 * the durability test simulates a restart. Reading back through the store that wrote it would only
 * prove it remembers what it was told a moment ago, which was never the failure.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);

const RULE = 'contains(element.name, "submit")';

/**
 * Wait for the other server to catch up.
 *
 * NOTIFY is delivered on commit and read on a second connection, so the update lands a moment after
 * the write returns. Polled rather than slept, so the test is not a fixed delay that is either flaky
 * or slow, and it fails on the timeout rather than on an assertion nobody can read.
 */
async function until(
  condition: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  await database.delete(actionPolicy).where(eq(actionPolicy.id, "current"));
});

describe("a rule added on one server", () => {
  test("is enforced on a server that never received the request", async () => {
    const wroteIt = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    const otherServer = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    await wroteIt.load();
    await otherServer.load();
    const listener = await startPolicyListener(databaseUrl, otherServer);

    try {
      expect(otherServer.get().deny).toEqual([]);

      await wroteIt.set({ mode: "enforce", deny: [RULE], allow: ["true"] });

      // Held in one process this stayed empty forever, and every click on that server went through.
      await until(() => otherServer.get().deny.length > 0);
      expect(otherServer.get().deny).toEqual([RULE]);
    } finally {
      await listener.stop();
    }
  });

  test("a reset reaches the other servers too", async () => {
    // The direction that is easy to forget. A reset means the deployment goes back to what
    // configuration says; if only the server that served it forgot the rule, the others would keep
    // refusing actions an administrator believes they have just allowed again.
    const wroteIt = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    const otherServer = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    await wroteIt.set({ mode: "enforce", deny: [RULE], allow: ["true"] });
    await otherServer.load();
    expect(otherServer.get().deny).toEqual([RULE]);

    const listener = await startPolicyListener(databaseUrl, otherServer);
    try {
      await wroteIt.reset();

      await until(() => otherServer.get().deny.length === 0);
      expect(otherServer.get().deny).toEqual([]);
      expect(otherServer.get().allow).toEqual(DEFAULT_ACTION_POLICY.allow);
    } finally {
      await listener.stop();
    }
  });

  test("the mode travels, so dry-run does not stay on somewhere", async () => {
    // Switching from dry-run to enforce is how an operator turns a boundary on for real. A server
    // still in dry-run records refusals and forwards the actions anyway.
    const wroteIt = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    const otherServer = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    await wroteIt.set({ mode: "dry-run", deny: [RULE], allow: ["true"] });
    await otherServer.load();
    expect(otherServer.get().mode).toBe("dry-run");

    const listener = await startPolicyListener(databaseUrl, otherServer);
    try {
      await wroteIt.set({ mode: "enforce", deny: [RULE], allow: ["true"] });

      await until(() => otherServer.get().mode === "enforce");
      expect(otherServer.get().mode).toBe("enforce");
    } finally {
      await listener.stop();
    }
  });

  test("a store with no database is unaffected, so a test without Postgres still works", async () => {
    // The in-memory store is what unit tests use. It has no fanout because it has no second process
    // to fan out to, and asking it to announce would make every one of those tests need a database.
    const store = createPolicyStore(DEFAULT_ACTION_POLICY);
    await store.set({ mode: "enforce", deny: [RULE], allow: ["true"] });
    await store.refresh();

    expect(store.get().deny).toEqual([RULE]);
  });
});

describe("a server that was not listening when it changed", () => {
  test("catches up when its subscription comes back", async () => {
    /*
     * A NOTIFY reaches whoever is listening at the time. A replica that was restarting, or whose
     * connection had dropped, is not, so it misses the announcement and goes on enforcing what it
     * read at boot until something restarts it again. That is the original bug wearing a smaller hat
     * and it is worse for being intermittent: the fleet disagrees with itself and nothing says so.
     *
     * Simulated the way it happens: the rule changes while this server has no subscription, and then
     * the subscription is established. `onlisten` fires on every establish, including reconnects, so
     * the row is re-read at exactly the moments a notification could have been missed.
     *
     * Thanks to @NathanTarbert, whose #94 caught this.
     */
    const wroteIt = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    const wasDown = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    await wasDown.load();
    expect(wasDown.get().deny).toEqual([]);

    // Changed while nothing on this server is listening.
    await wroteIt.set({ mode: "enforce", deny: [RULE], allow: ["true"] });
    expect(wasDown.get().deny).toEqual([]);

    const listener = await startPolicyListener(databaseUrl, wasDown);
    try {
      await until(() => wasDown.get().deny.length > 0);
      expect(wasDown.get().deny).toEqual([RULE]);
    } finally {
      await listener.stop();
    }
  });
});

describe("the announcement itself", () => {
  test("a write that rolls back announces nothing", async () => {
    /*
     * The announcement is in the same transaction as the write, so it is delivered on commit. A
     * failed write that had already announced would have every other server re-read a row that never
     * changed, which is harmless, and a committed write that had not announced yet leaves them stale,
     * which is not. Same shape as channel activity.
     */
    const listening = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    await listening.load();
    const listener = await startPolicyListener(databaseUrl, listening);

    try {
      // A store whose write fails after the insert. The transaction rolls back, taking the
      // announcement with it.
      const failing = new Proxy(database, {
        get: (target, property, receiver) =>
          property === "transaction"
            ? async () => {
                throw new Error("the write rolled back");
              }
            : Reflect.get(target, property, receiver),
      });
      const store = createPolicyStore(DEFAULT_ACTION_POLICY, failing);

      await expect(
        store.set({ mode: "enforce", deny: [RULE], allow: ["true"] }),
      ).rejects.toThrow();

      // Nothing was saved, so nothing should have been announced and nobody should have moved.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(listening.get().deny).toEqual([]);
    } finally {
      await listener.stop();
    }
  });

  test("a saved rule is not lost when the announcement fails", async () => {
    // The row is the record and this process is already enforcing it. Failing the write here would
    // tell an administrator their rule was rejected when it is saved and live, which is worse than
    // the other servers being briefly behind.
    // A proxy rather than a spread: drizzle's methods do not survive being copied off the object,
    // and a fake that had lost `insert` would fail this test for the wrong reason.
    const broken = new Proxy(database, {
      get: (target, property, receiver) =>
        property === "execute"
          ? async () => {
              throw new Error("pg_notify is unavailable");
            }
          : Reflect.get(target, property, receiver),
    });

    const store = createPolicyStore(DEFAULT_ACTION_POLICY, broken);
    await expect(
      store.set({ mode: "enforce", deny: [RULE], allow: ["true"] }),
    ).resolves.toBeUndefined();
    expect(store.get().deny).toEqual([RULE]);
  });
});
