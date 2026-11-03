/**
 * The audit outbox and its drainer: what is written here reaches Intelligence's trail, once each, in
 * order, whatever happens on the way.
 *
 * The trail lives in Intelligence. A row is written to `audit_outbox` in its writer's transaction and
 * a drainer carries it over; these cases are the ways that can go wrong and must not. Against the real
 * test Intelligence: where a case needs Intelligence to be unreachable, the transport in front of it
 * fails while a switch is on, and everything that does arrive arrives at the real one.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { addAuditTap, createAuditStore } from "../src/audit";
import { createAuditTrailClient } from "../src/audit-trail/client";
import { createAuditDrainer } from "../src/audit-trail/drainer";
import { createDatabase } from "../src/db/client";
import { auditOutbox } from "../src/db/schema";
import { auditRows, flushAuditTrail, useTestAuditTrail } from "./support/audit";
import { testIntelligence } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createAuditStore(database);

afterAll(async () => {
  await database.$client.close();
});

/**
 * A client of the real test Intelligence whose network can be cut, and which notes the ids of every
 * record it sends, in the order sent.
 */
function switchableClient() {
  const intelligence = testIntelligence();
  const state = { down: false, sent: [] as string[] };
  const client = createAuditTrailClient({
    apiUrl: intelligence.apiUrl,
    apiKey: intelligence.apiKey,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (state.down) throw new TypeError("fetch failed: connection refused");
      if (init?.method === "POST" && typeof init.body === "string") {
        const body = JSON.parse(init.body) as Record<string, { id: string }[]>;
        for (const records of Object.values(body))
          state.sent.push(...records.map((record) => record.id));
      }
      return fetch(input, init);
    }) as typeof fetch,
  });
  return { client, state };
}

/** Rows this test wrote, by the target it gave them. */
async function outboxRows(targetId: string) {
  return database
    .select({
      seq: auditOutbox.seq,
      id: sql<string>`${auditOutbox.id}::text`,
      refusedAt: auditOutbox.refusedAt,
      refusal: auditOutbox.refusal,
    })
    .from(auditOutbox)
    .where(sql`${auditOutbox.record}->'target'->>'id' = ${targetId}`)
    .orderBy(auditOutbox.seq);
}

const write = (targetId: string, n: number, payload = {}) =>
  store.insert({
    eventType: "configuration.changed",
    targetType: "audit_outbox_test",
    targetId,
    payload: { n, ...payload },
  });

describe("the audit outbox", () => {
  test("events written while Intelligence is unreachable are kept, and arrive in order once it answers", async () => {
    // Empty the shared outbox first, so what this drainer sends is this test's alone.
    await flushAuditTrail();
    const targetId = `outbox-outage-${randomUUID()}`;
    const { client, state } = switchableClient();
    const drainer = createAuditDrainer({ database, client });
    state.down = true;

    for (const n of [1, 2, 3]) await write(targetId, n);
    await expect(drainer.flush()).rejects.toThrow();

    // Nothing lost while it was down: every row waits, unrefused.
    const waiting = await outboxRows(targetId);
    expect(waiting).toHaveLength(3);
    expect(waiting.every((row) => row.refusedAt === null)).toBe(true);

    state.down = false;
    await drainer.flush();

    // Sent in the order written, and gone from the outbox only once stored.
    expect(state.sent).toEqual(waiting.map((row) => row.id));
    expect(await outboxRows(targetId)).toEqual([]);
    const stored = await auditRows({ targetId });
    expect(stored.map((row) => row.payload.n)).toEqual([3, 2, 1]);
    expect(stored.map((row) => row.id).reverse()).toEqual(
      waiting.map((row) => row.id),
    );
  });

  test("a running drainer says it cannot deliver, backs off, and delivers once Intelligence answers", async () => {
    await flushAuditTrail();
    const targetId = `outbox-background-${randomUUID()}`;
    const { client, state } = switchableClient();
    const drainer = createAuditDrainer({
      database,
      client,
      intervalMs: 50,
      nudgeDelayMs: 5,
      maxBackoffMs: 200,
    });
    const said: string[] = [];
    const error = console.error;
    console.error = (line: unknown) => {
      said.push(String(line));
    };
    state.down = true;
    drainer.start();
    try {
      await write(targetId, 1);
      await waitFor(() =>
        said.some((line) => line.includes('"audit-outbox-undelivered"')),
      );
      const loud = JSON.parse(
        said.find((line) => line.includes('"audit-outbox-undelivered"')) ??
          "{}",
      ) as { backlog?: number; retryInMs?: number };
      expect(loud.backlog).toBeGreaterThanOrEqual(1);
      expect(loud.retryInMs).toBeGreaterThan(0);

      state.down = false;
      await waitFor(async () => (await outboxRows(targetId)).length === 0);
    } finally {
      console.error = error;
      await drainer.stop();
    }
    expect((await auditRows({ targetId })).map((row) => row.payload.n)).toEqual(
      [1],
    );
  });

  test("two drainers at once never lose an event and never send one twice", async () => {
    await flushAuditTrail();
    const targetId = `outbox-two-drainers-${randomUUID()}`;
    const first = switchableClient();
    const second = switchableClient();
    const drainers = [
      createAuditDrainer({ database, client: first.client, batchSize: 50 }),
      createAuditDrainer({ database, client: second.client, batchSize: 50 }),
    ];
    for (let n = 0; n < 300; n += 1) await write(targetId, n);
    const written = (await outboxRows(targetId)).map((row) => row.id);

    await Promise.all([
      drainers[0]?.flush(),
      drainers[1]?.flush(),
      drainers[0]?.flush(),
      drainers[1]?.flush(),
    ]);

    // One at a time: every id was sent exactly once between the two of them.
    const sent = [...first.state.sent, ...second.state.sent].filter((id) =>
      written.includes(id),
    );
    expect(sent.toSorted()).toEqual(written.toSorted());
    expect(await outboxRows(targetId)).toEqual([]);
    const stored = await auditRows({ targetId });
    expect(stored).toHaveLength(300);
    expect(new Set(stored.map((row) => row.payload.n)).size).toBe(300);
  });

  test("a row Intelligence refuses is set aside with its reason, loudly, and the rest arrive", async () => {
    await flushAuditTrail();
    const targetId = `outbox-refused-${randomUUID()}`;
    const said: string[] = [];
    const error = console.error;
    console.error = (line: unknown) => {
      said.push(String(line));
    };
    try {
      await write(targetId, 1);
      // Past the 64 KB a payload may be in Intelligence.
      await write(targetId, 2, { notes: "x".repeat(70 * 1024) });
      await write(targetId, 3);
      await flushAuditTrail();
    } finally {
      console.error = error;
    }

    const left = await outboxRows(targetId);
    expect(left).toHaveLength(1);
    expect(left[0]?.refusedAt).toBeInstanceOf(Date);
    expect(left[0]?.refusal).toContain("AUDIT_VALIDATION_ERROR");
    expect(
      said.some(
        (line) =>
          line.includes('"audit-outbox-refused"') &&
          line.includes(left[0]?.id ?? "-"),
      ),
    ).toBe(true);
    expect((await auditRows({ targetId })).map((row) => row.payload.n)).toEqual(
      [3, 1],
    );
    // Set aside means not sent again.
    await flushAuditTrail();
    expect(await outboxRows(targetId)).toHaveLength(1);
    await database
      .delete(auditOutbox)
      .where(eq(auditOutbox.seq, left[0]?.seq ?? -1));
  });

  test("a row is stored as a JSON object, not as a string of one", async () => {
    /*
     * Handed a string for a `jsonb` parameter, Bun's driver encodes it a second time, and the outbox
     * held a JSON string: every row was then refused by Intelligence as invalid and set aside, and
     * the trail stayed empty while every write reported success.
     */
    const targetId = `outbox-shape-${randomUUID()}`;
    await write(targetId, 1, { bot: "outbox-shape" });
    const [row] = await database.execute<{ shape: string; bot: string }>(
      sql`select jsonb_typeof(record) as shape, record->'payload'->>'bot' as bot
          from audit_outbox where record->'target'->>'id' = ${targetId}`,
    );
    expect(row).toEqual({ shape: "object", bot: "outbox-shape" });
    expect(
      (await auditRows({ targetId })).map((stored) => stored.payload.bot),
    ).toEqual(["outbox-shape"]);
  });

  test("a row written in a transaction that rolls back never reaches the trail", async () => {
    const targetId = `outbox-rolled-back-${randomUUID()}`;
    await database
      .transaction(async (tx) => {
        await createAuditStore(tx as unknown as typeof database).insert({
          eventType: "configuration.changed",
          targetType: "audit_outbox_test",
          targetId,
          payload: {},
        });
        throw new Error("rolled back on purpose");
      })
      .catch(() => undefined);
    await write(`${targetId}-kept`, 1);

    expect(await outboxRows(targetId)).toEqual([]);
    expect(await auditRows({ targetId })).toEqual([]);
    expect(await auditRows({ targetId: `${targetId}-kept` })).toHaveLength(1);
  });

  test("taps hear a row once it is written, redacted, as they heard the old insert", async () => {
    const targetId = `outbox-tap-${randomUUID()}`;
    const heard: { targetId?: string; payload: Record<string, unknown> }[] = [];
    const remove = addAuditTap((event) => {
      if (event.targetId === targetId) heard.push(event);
    });
    try {
      await store.insert({
        eventType: "credential.created",
        targetType: "audit_outbox_test",
        targetId,
        payload: { token: "secret-value", kind: "api_key" },
      });
    } finally {
      remove();
    }
    expect(heard).toEqual([
      expect.objectContaining({
        targetId,
        payload: { token: "[REDACTED]", kind: "api_key" },
      }),
    ]);
    expect((await auditRows({ targetId }))[0]?.payload).toEqual({
      token: "[REDACTED]",
      kind: "api_key",
    });
  });
});

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
) {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs)
      throw new Error("Timed out waiting for the drainer.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

useTestAuditTrail();
