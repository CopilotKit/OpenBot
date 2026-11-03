import {
  addAuditTap,
  createAuditStore,
  type AuditTapEvent,
} from "../src/audit";
import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { observedProductRun } from "../scripts/support/product-run";
import { createDatabase } from "../src/db/client";
import { productTelemetryEvents, productTelemetryRuns } from "../src/db/schema";
import { createProductTelemetry } from "../src/telemetry/product";
import { createProductStore } from "../src/telemetry/product-store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createProductStore(database);
const suite = `telemetry-${randomUUID()}`;
const runIds = [`${suite}-one`, `${suite}-two`];
const actor = `${suite}-actor`;
const env = { OPENBOT_PRODUCT_TELEMETRY: "1", NODE_ENV: "test" };
afterAll(async () => {
  try {
    const run = await store.run(runIds[0]);
    if (run)
      await database
        .delete(productTelemetryEvents)
        .where(
          sql`${productTelemetryEvents.properties}->>'user_id' = ${run.context.user_id}`,
        );
    await database
      .delete(productTelemetryRuns)
      .where(inArray(productTelemetryRuns.runId, runIds));
  } finally {
    await database.$client.close();
  }
});

test("database identity is stable across adapters and concurrent initialization", async () => {
  const identities = await Promise.all([
    store.identity(),
    createProductStore(database).identity(),
  ]);
  expect(identities[0]).toEqual(identities[1]);
});
test("database ledger keeps terminal, consumption and activation once after adapter restart", async () => {
  const first = await createProductTelemetry({
    store,
    env,
    send: async () => {},
  });
  await observedProductRun(first, {
    actor,
    thread: suite,
    run: runIds[0],
    root: suite,
  });
  const second = await createProductTelemetry({
    store: createProductStore(database),
    env,
    send: async () => {},
  });
  await observedProductRun(second, {
    actor,
    thread: suite,
    run: runIds[1],
    root: suite,
    attempt: 2,
  });
  expect((await store.run(runIds[0]))?.outcome).toBe("success");
  expect(
    await store.result("another-user", suite, `message-${runIds[0]}`),
  ).toBeNull();
  const action = {
    kind: "result_viewed" as const,
    threadId: suite,
    messageId: `message-${runIds[0]}`,
    surface: "web" as const,
  };
  await first.consume(actor, action);
  await second.consume(actor, action);
  await first.flush();
  await second.flush();
  const rows = await database.select().from(productTelemetryEvents);
  const user = (await store.run(runIds[0]))?.context.user_id;
  expect(
    rows.filter(
      (r) =>
        r.properties.user_id === user && r.name.endsWith("first_human_success"),
    ),
  ).toHaveLength(1);
  expect(
    rows.filter(
      (r) => r.properties.user_id === user && r.name.endsWith("result_viewed"),
    ),
  ).toHaveLength(1);
});

test("replicas claim one event atomically and failed claims remain replayable", async () => {
  const id = `${suite}-claim`;
  await store.event({
    id,
    name: "oss.runtime.openbot.capability",
    properties: {},
    createdAt: new Date(),
  });
  let calls = 0;
  await Promise.all([
    store.deliver(id, async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }),
    createProductStore(database).deliver(id, async () => {
      calls++;
    }),
  ]);
  expect(calls).toBe(1);
  expect(
    await store.deliver(id, async () => {
      calls++;
    }),
  ).toBe(false);
  const failedId = `${suite}-failed-claim`;
  await store.event({
    id: failedId,
    name: "oss.runtime.openbot.capability",
    properties: {},
    createdAt: new Date(),
  });
  await expect(
    store.deliver(failedId, async () => {
      throw new Error("synthetic send failure");
    }),
  ).rejects.toThrow("synthetic send failure");
  expect(
    await createProductStore(database).deliver(failedId, async () => {}),
  ).toBe(true);
  await database
    .delete(productTelemetryEvents)
    .where(inArray(productTelemetryEvents.id, [id, failedId]));
});

test("audit taps carry the actual persisted ID and redacted payload", async () => {
  let seen: AuditTapEvent | undefined;
  const remove = addAuditTap((event) => {
    if (event.targetId === suite) seen = event;
  });
  try {
    await createAuditStore(database).insert({
      eventType: "credential.created",
      targetType: "credential",
      targetId: suite,
      actorUserId: actor,
      payload: { apiKey: "synthetic-private-secret" },
    });
  } finally {
    remove();
  }
  expect(seen?.id).toMatch(/^[a-f0-9-]{36}$/);
  expect(seen?.createdAt).toBeInstanceOf(Date);
  expect(seen?.payload).toEqual({ apiKey: "[REDACTED]" });
});
