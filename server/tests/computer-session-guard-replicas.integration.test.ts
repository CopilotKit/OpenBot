import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { StaleSnapshotError } from "../src/computer/client";
import { createComputerGateway } from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import type { SnapshotResult } from "../src/computer/schema";
import { createSnapshotStore } from "../src/computer/snapshot-store";
import { createDockerSupervisorProvider } from "../src/computer/supervisor";
import { createDatabase } from "../src/db/client";
import { computerSnapshot } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * Two replicas, one Postgres, a container replaced between them.
 *
 * The in-process guard tests share a Map-free provider but an in-memory snapshot store. This is the
 * shape the bug is actually about: the snapshot crosses processes through Postgres, and the run it
 * belongs to has to cross with it. Replica A takes the snapshot; replica B, which has never located
 * this Bot, gets the click after the container was replaced.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const botId = `agent_replica_${suite}`;

const FIRST_RUN = "2026-08-25T10:00:00.000Z";
const SECOND_RUN = "2026-08-25T11:30:00.000Z";
const PERMISSIVE: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };
const ACTOR = { id: "dev-local-user" };

const SNAPSHOT: SnapshotResult = {
  snapshotId: 7,
  url: "https://example.com/order",
  title: "Order",
  truncated: false,
  elements: [{ ref: "e9", role: "button", name: "Submit order" }],
};

function fakeSupervisor(startedAt: () => string, known: string[] = []) {
  const ensured = new Set(known);
  const describe = (id: string) => ({
    botId: id,
    container: `openbot-computer-${id}`,
    status: "running",
    url: "http://openbot-computer:4100",
    startedAt: startedAt(),
  });
  return (async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/ensure")) {
      const asked = decodeURIComponent(
        path.slice("/computers/".length, -"/ensure".length),
      );
      ensured.add(asked);
      return Response.json(describe(asked));
    }
    return Response.json({
      computers: [...ensured].map((id) => describe(id)),
    });
  }) as unknown as typeof fetch;
}

function fakeComputerFetch() {
  return (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/snapshot") return Response.json(SNAPSHOT);
    if (path === "/click")
      return Response.json({
        action: "click",
        url: SNAPSHOT.url,
        elapsedMs: 1,
      });
    return Response.json({ error: path }, { status: 404 });
  }) as unknown as typeof fetch;
}

/** One server replica: its own provider and gateway, sharing only Postgres. */
function replica(startedAt: () => string, known: string[] = []) {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (e) => void rows.push(e) };
  const provider = createDockerSupervisorProvider({
    baseUrl: "http://supervisor:4300",
    fetchImpl: fakeSupervisor(startedAt, known),
  });
  const gateway = createComputerGateway({
    provider,
    fetchImpl: fakeComputerFetch(),
    auditStore: store,
    policy: () => PERMISSIVE,
    // The real store, against the real database.
    snapshots: createSnapshotStore(database),
  });
  return { gateway, rows };
}

beforeAll(async () => {
  await database
    .delete(computerSnapshot)
    .where(eq(computerSnapshot.computerId, botId));
});

afterAll(async () => {
  await database
    .delete(computerSnapshot)
    .where(eq(computerSnapshot.computerId, botId));
});

test("replica B refuses a ref that replica A took before the container was replaced", async () => {
  // Replica A: takes the snapshot during the first run. Writes it to Postgres.
  const a = replica(() => FIRST_RUN);
  await a.gateway.snapshot(botId);

  // The row really is in Postgres, carrying the run it was taken on.
  const [stored] = await database
    .select({ session: computerSnapshot.session })
    .from(computerSnapshot)
    .where(eq(computerSnapshot.computerId, botId));
  expect(stored?.session).toBe(FIRST_RUN);

  // Replica B: a different process. Never located this Bot, so it holds nothing for it. The
  // container has since been replaced, so the supervisor now reports the second run.
  const b = replica(() => SECOND_RUN, [botId]);
  const clicked = await b.gateway
    .click(botId, ACTOR, { ref: "e9", snapshotId: 7 })
    .catch((error: unknown) => error);

  expect(clicked).toBeInstanceOf(StaleSnapshotError);
});

test("CONTROL: replica B allows the same ref while the run is still current", async () => {
  const a = replica(() => FIRST_RUN);
  await a.gateway.snapshot(botId);

  // Same cold replica, but the container was never replaced.
  const b = replica(() => FIRST_RUN, [botId]);
  const result = await b.gateway.click(botId, ACTOR, {
    ref: "e9",
    snapshotId: 7,
  });
  expect(result).toMatchObject({ action: "click" });
});
