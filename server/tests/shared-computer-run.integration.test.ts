import { afterEach, describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { StaleSnapshotError } from "../src/computer/client";
import { createComputerGateway } from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import { createSharedComputerProvider } from "../src/computer/provider";
import type { SnapshotResult } from "../src/computer/schema";
import { createSnapshotStore } from "../src/computer/snapshot-store";
import { createDatabase } from "../src/db/client";
import { computerSnapshot } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * The one shared computer, through the table rather than through a `Map`.
 *
 * `computer-gateway.test.ts` covers this deployment against the in-memory store, and the two stores
 * are separate implementations of the same rule: one is a comparison in TypeScript and the other is
 * a `setWhere` Postgres evaluates. Ordering across runs is exactly where they could disagree, and a
 * deployment runs the one that is not covered by that file.
 *
 * Everything below the stub computer is real: the provider makes its own HTTP calls, the gateway
 * resolves and governs, and the row is a row.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

afterEach(async () => {
  await database.delete(computerSnapshot);
});

const PERMISSIVE: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };
const ACTOR = { id: "dev-local-user" };

const DEAD: SnapshotResult = {
  snapshotId: 7,
  url: "https://bank.example/transfer",
  title: "Transfer",
  truncated: false,
  elements: [{ ref: "e9", role: "button", name: "Confirm transfer" }],
};

const FRESH: SnapshotResult = {
  snapshotId: 1,
  url: "https://fresh.example/start",
  title: "Start",
  truncated: false,
  elements: [{ ref: "e1", role: "link", name: "Sign in" }],
};

/** A shared computer that answers which run each Bot's browser is on, as the real one does. */
function sharedComputer() {
  let run = "run-1";
  let live: SnapshotResult = DEAD;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/run") return Response.json({ run });
      if (path === "/snapshot") return Response.json(live);
      if (path === "/computers/reset") return Response.json({ reset: true });
      if (path === "/click")
        return Response.json({ action: "click", url: live.url, elapsedMs: 1 });
      return Response.json({ error: path }, { status: 404 });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    /** A new browser session: a restart, an eviction, a redeploy, or a reset. */
    replaceRun: (next: string) => {
      run = next;
    },
    showing: (next: SnapshotResult) => {
      live = next;
    },
  };
}

function gatewayOn(computer: ReturnType<typeof sharedComputer>) {
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const snapshots = createSnapshotStore(database);
  return {
    rows,
    snapshots,
    gateway: createComputerGateway({
      provider: createSharedComputerProvider({ baseUrl: computer.baseUrl }),
      auditStore,
      policy: () => PERMISSIVE,
      snapshots,
    }),
  };
}

describe("a Bot on the one shared computer, against the table", () => {
  test("a save still in flight when the wipe landed cannot resurrect the page", async () => {
    const computer = sharedComputer();
    try {
      const { gateway, rows, snapshots } = gatewayOn(computer);
      const taken = await gateway.snapshot("bot-1");

      await gateway.resetComputer("bot-1", ACTOR);
      expect(await snapshots.load("bot-1")).toBeUndefined();
      computer.replaceRun("run-2");
      // The row is gone, so this inserts rather than conflicting, which is the whole of the race.
      await snapshots.save("bot-1", {
        snapshotId: taken.snapshotId,
        url: taken.url,
        elements: new Map(
          taken.elements.map((element) => [element.ref, element]),
        ),
        session: "run-1",
      });
      expect((await snapshots.load("bot-1"))?.url).toBe(DEAD.url);

      const refusal = await gateway
        .click("bot-1", ACTOR, { ref: "e9", snapshotId: taken.snapshotId })
        .catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(StaleSnapshotError);
      expect(rows.at(-1)?.payload.element).toBe("not in the current snapshot");
    } finally {
      computer.stop();
    }
  });

  test("a restarted computer's first snapshot takes the update branch", async () => {
    /*
     * The `setWhere` case that only Postgres decides. The row holds generation seven, the fresh
     * browser offers one, and on the generation alone `lt(7, 1)` is false and the update is skipped
     * with no error to say so. The run is what makes it land.
     */
    const computer = sharedComputer();
    try {
      const { gateway, snapshots } = gatewayOn(computer);
      await gateway.snapshot("bot-1");
      expect((await snapshots.load("bot-1"))?.snapshotId).toBe(7);

      computer.replaceRun("run-2");
      computer.showing(FRESH);
      await gateway.snapshot("bot-1");

      // Read through a second store, the way a second replica would, rather than from the one that
      // wrote it.
      const held = await createSnapshotStore(database).load("bot-1");
      expect(held?.snapshotId).toBe(1);
      expect(held?.url).toBe(FRESH.url);
      expect(held?.session).toBe("run-2");
    } finally {
      computer.stop();
    }
  });

  test("and its refs resolve again, rather than the dead page's", async () => {
    // What the row is for. Landing the fresh snapshot is only half the property; the other half is
    // that the boundary now decides about the page somebody is actually on.
    const computer = sharedComputer();
    try {
      const { gateway, rows } = gatewayOn(computer);
      await gateway.snapshot("bot-1");
      computer.replaceRun("run-2");
      computer.showing(FRESH);
      const fresh = await gateway.snapshot("bot-1");

      await gateway.click("bot-1", ACTOR, {
        ref: "e1",
        snapshotId: fresh.snapshotId,
      });

      expect(rows.at(-1)?.payload.element).toMatchObject({ name: "Sign in" });
    } finally {
      computer.stop();
    }
  });

  test("within one run an older snapshot still does not overwrite a newer one", async () => {
    // The control, and the property #46 established. Ordering across runs that stopped ordering
    // within one would let two replicas snapshotting the same computer land in whichever order
    // Postgres happened to see them.
    const computer = sharedComputer();
    try {
      const { gateway, snapshots } = gatewayOn(computer);
      await gateway.snapshot("bot-1");
      computer.showing(FRESH);
      await gateway.snapshot("bot-1");

      expect((await snapshots.load("bot-1"))?.snapshotId).toBe(7);
      expect((await snapshots.load("bot-1"))?.url).toBe(DEAD.url);
    } finally {
      computer.stop();
    }
  });

  test("a computer that cannot say which run it is on leaves the row unordered, not refused", async () => {
    /*
     * A computer from before `/run` existed. Unknown is not mismatched: the ordering goes back to the
     * generation alone, which is where it started, and every ref still resolves. A fix that turned a
     * missing answer into a refusal would take a working deployment down on the way to fixing this.
     */
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/snapshot") return Response.json(DEAD);
        if (path === "/click")
          return Response.json({
            action: "click",
            url: DEAD.url,
            elapsedMs: 1,
          });
        return Response.json({ error: "Not found." }, { status: 404 });
      },
    });
    try {
      const rows: AuditEventInput[] = [];
      const auditStore: AuditStore = {
        insert: async (event) => void rows.push(event),
      };
      const snapshots = createSnapshotStore(database);
      const gateway = createComputerGateway({
        provider: createSharedComputerProvider({
          baseUrl: `http://127.0.0.1:${server.port}`,
        }),
        auditStore,
        policy: () => PERMISSIVE,
        snapshots,
      });

      const taken = await gateway.snapshot("bot-1");
      expect((await snapshots.load("bot-1"))?.session).toBeUndefined();

      await gateway.click("bot-1", ACTOR, {
        ref: "e9",
        snapshotId: taken.snapshotId,
      });
      expect(rows.at(-1)?.payload.element).toMatchObject({
        name: "Confirm transfer",
      });
    } finally {
      server.stop(true);
    }
  });
});
