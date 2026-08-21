import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import {
  ACTION_POLICY_TOPIC,
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
  type PolicyStore,
  startActionPolicyListener,
} from "../src/computer/policy-store";
import type { Database } from "../src/db/client";

/**
 * A boundary an administrator sets has to apply on every replica, not on the one that answered.
 *
 * OpenBot runs as several server processes behind a load balancer, so the process that saved a deny
 * rule is roughly one in N of the processes that will decide the next action. A policy kept only in
 * the process that wrote it means the rule is enforced on about 1/N of what a Bot does, while the
 * administrator's screen and the audit row both report success. That is worse than the rule being
 * rejected: nobody is told the boundary is only partly there.
 *
 * The fleet is simulated rather than started: one fake deployment holding the single `action_policy`
 * row, and several stores over it, which is what several replicas are from this module's point of
 * view. `LISTEN`/`NOTIFY` is faked at the same seam the driver sits at, so the subscription code
 * under test is the real one and the test needs no Postgres.
 */

const configured = DEFAULT_ACTION_POLICY;
const rule = 'intent == "activate" && contains(element.name, "submit")';

type Row = {
  mode: string;
  deny: string[];
  allow: string[];
  updatedBy: string | null;
};

/**
 * One `action_policy` row and one notification bus, shared by every replica in the test.
 *
 * Only the handful of calls the store makes are implemented. A fuller fake would be a second
 * database to keep in agreement with the first, and what these tests are about is which process sees
 * a change, not how drizzle builds a statement.
 */
function createFakeDeployment() {
  let row: Row | undefined;
  /** Announcements are held until the transaction that made them returns, as commit-time delivery. */
  let pending: string[] = [];
  const subscribers = new Set<(payload: string) => void>();
  const reconnects = new Set<() => void>();

  const deliver = () => {
    const announcements = pending;
    pending = [];
    for (const payload of announcements) {
      for (const subscriber of [...subscribers]) subscriber(payload);
    }
  };

  let failNextCommit = false;

  const database = {
    transaction: async (run: (transaction: unknown) => Promise<unknown>) => {
      const before = row ? { ...row } : undefined;
      const result = await run(database);
      if (failNextCommit) {
        // A commit that fails after the statements ran. The row goes back and the announcements
        // made inside the transaction go with it, which is what `pg_notify` in a transaction does.
        failNextCommit = false;
        row = before;
        pending = [];
        throw new Error("Commit failed.");
      }
      deliver();
      return result;
    },
    insert: () => ({
      values: (values: Row) => ({
        onConflictDoUpdate: async () => {
          row = {
            mode: values.mode,
            deny: [...values.deny],
            allow: [...values.allow],
            updatedBy: values.updatedBy,
          };
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        row = undefined;
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (row ? [row] : []),
        }),
      }),
    }),
    execute: async (query: SQL) => {
      // The topic is a value in the statement, so an announcement on some other topic reaches
      // nobody here either. A listener that subscribed to a different name is the production bug
      // this stands in for.
      const [topic] = (
        query as unknown as { queryChunks: unknown[] }
      ).queryChunks.filter(
        (chunk): chunk is string => typeof chunk === "string",
      );
      if (topic === ACTION_POLICY_TOPIC) pending.push("");
    },
  };

  return {
    database: database as unknown as Database,
    /** Stands in for the dedicated connection `LISTEN` holds. */
    connect: () => {
      const mine = new Set<(payload: string) => void>();
      let onReconnect: (() => void) | undefined;
      return {
        listen: async (
          topic: string,
          onNotify: (payload: string) => void,
          onListen?: () => void,
        ) => {
          if (topic !== ACTION_POLICY_TOPIC) {
            throw new Error(`Nothing announces on ${topic}.`);
          }
          mine.add(onNotify);
          subscribers.add(onNotify);
          onReconnect = () => onListen?.();
          reconnects.add(onReconnect);
          onListen?.();
          return {};
        },
        end: async () => {
          for (const subscriber of mine) subscribers.delete(subscriber);
          mine.clear();
          if (onReconnect) reconnects.delete(onReconnect);
        },
      };
    },
    /** The next transaction runs its statements and then fails to commit. */
    breakNextCommit: () => {
      failNextCommit = true;
    },
    /** A dropped connection: the subscription is still declared, nothing is being delivered. */
    dropConnections: () => {
      subscribers.clear();
    },
    /** What the driver does once a dropped connection comes back: it says `LISTEN` again. */
    reconnectListeners: () => {
      for (const onListen of [...reconnects]) onListen();
    },
    rowCount: () => (row ? 1 : 0),
  };
}

/** Let the announcement, the reload it triggers and the read after it all finish. */
async function settle() {
  for (let i = 0; i < 5; i += 1)
    await new Promise((done) => setTimeout(done, 0));
}

/** A replica: its own store, its own subscription, over the shared deployment. */
async function startReplica(
  deployment: ReturnType<typeof createFakeDeployment>,
) {
  const store: PolicyStore = createPolicyStore(configured, deployment.database);
  await store.load();
  const listener = await startActionPolicyListener(
    "postgres://unused",
    store,
    deployment.connect,
  );
  return { store, listener };
}

describe("a boundary set on one replica", () => {
  test("is enforced on the replica that never saw the request", async () => {
    const deployment = createFakeDeployment();
    const admin = await startReplica(deployment);
    const other = await startReplica(deployment);

    await admin.store.set(
      { mode: "enforce", deny: [rule], allow: ["true"] },
      "admin@example.test",
    );
    await settle();

    // The whole point. Without fan-out this replica is still enforcing what it read at boot, and
    // the Bot actions the load balancer sends here go through the deny rule as if it did not exist.
    expect(other.store.get().deny).toEqual([rule]);
    expect(other.store.get().mode).toBe("enforce");
    expect(admin.store.get().deny).toEqual([rule]);

    await admin.listener.stop();
    await other.listener.stop();
  });

  test("is lifted on the other replica when it is reset", async () => {
    const deployment = createFakeDeployment();
    const admin = await startReplica(deployment);
    const other = await startReplica(deployment);

    await admin.store.set({ mode: "enforce", deny: [rule], allow: ["true"] });
    await settle();
    await admin.store.reset();
    await settle();

    // A rule that cannot be taken back everywhere is as bad as one that cannot be added everywhere:
    // the administrator is told the boundary is gone while a replica still refuses the action.
    expect(deployment.rowCount()).toBe(0);
    expect(other.store.get()).toEqual(configured);

    await admin.listener.stop();
    await other.listener.stop();
  });

  test("reaches a replica that was disconnected when it was announced", async () => {
    const deployment = createFakeDeployment();
    const admin = await startReplica(deployment);
    const other = await startReplica(deployment);

    // The announcement is a nudge and never the record. A replica whose connection was down for the
    // moment it was sent must not enforce yesterday's boundary until somebody restarts it.
    deployment.dropConnections();
    await admin.store.set({ mode: "enforce", deny: [rule], allow: ["true"] });
    await settle();
    expect(other.store.get().deny).toEqual([]);

    deployment.reconnectListeners();
    await settle();

    // Recovered from the table, which is the only thing that was ever authoritative.
    expect(other.store.get().deny).toEqual([rule]);

    await admin.listener.stop();
    await other.listener.stop();
  });

  test("is not announced when the write it belongs to did not commit", async () => {
    const deployment = createFakeDeployment();
    const admin = await startReplica(deployment);
    const other = await startReplica(deployment);

    // The announcement rides the same transaction as the write, so a write that rolled back
    // announces nothing. A replica told to re-read after a failed save would only re-read the row
    // that is still there, but it would be told the boundary moved when it did not.
    deployment.breakNextCommit();
    await expect(
      admin.store.set({ mode: "enforce", deny: [rule], allow: ["true"] }),
    ).rejects.toThrow("Commit failed.");
    await settle();

    expect(deployment.rowCount()).toBe(0);
    expect(other.store.get()).toEqual(configured);
    // And the process that failed to save is not enforcing what it failed to save.
    expect(admin.store.get()).toEqual(configured);

    await admin.listener.stop();
    await other.listener.stop();
  });

  test("without a database there is nothing to announce and nothing breaks", async () => {
    // A deployment with no database is a single process by definition, and a test about decision
    // logic must not need Postgres to build a store.
    const store = createPolicyStore(configured);
    await store.load();
    await store.set({ mode: "enforce", deny: [rule], allow: ["true"] });
    expect(store.get().deny).toEqual([rule]);
    await store.reset();
    expect(store.get()).toEqual(configured);
  });
});
