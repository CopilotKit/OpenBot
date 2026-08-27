import { afterEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { startRetentionSweeps } from "../src/audit-retention";
import {
  createPageFrameStore,
  FRAME_RETENTION_MS,
} from "../src/computer/page-frames";
import { createDatabase } from "../src/db/client";
import { computerPageFrame } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * The screenshots have to be able to stop growing, in every deployment rather than in one.
 *
 * Their reaper had a single caller, `scripts/cull-idle-computers.ts`, which refuses to run unless the
 * provider is `sandbox` and is scheduled only by the chart's culler CronJob, which renders only in
 * that mode. Compose, the all-in-one image and the chart's own default of `computers.mode: shared`
 * therefore wrote a row per navigation and removed none, ever.
 *
 * Against a real database because the interval arithmetic and the batching are both SQL.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const store = createPageFrameStore(database);

const COMPUTER = `frame-retention-${crypto.randomUUID().slice(0, 8)}`;

async function frame(daysAgo: number, index: number): Promise<void> {
  await store.save({
    computerId: COMPUTER,
    toolCallId: `turn-${index}`,
    url: `https://example.com/${index}`,
    title: `page ${index}`,
    frame: "iVBORw0KGgo=",
  });
  await database
    .update(computerPageFrame)
    .set({ capturedAt: sql`now() - make_interval(days => ${daysAgo})` })
    .where(eq(computerPageFrame.toolCallId, `turn-${index}`));
}

const kept = () =>
  database
    .select({ toolCallId: computerPageFrame.toolCallId })
    .from(computerPageFrame)
    .where(eq(computerPageFrame.computerId, COMPUTER));

afterEach(async () => {
  await database
    .delete(computerPageFrame)
    .where(eq(computerPageFrame.computerId, COMPUTER));
});

describe("page frame retention", () => {
  test("a deployment that has not configured audit retention still sweeps frames", async () => {
    await frame(90, 1);
    await frame(31, 2);
    await frame(1, 3);

    /*
     * `undefined` is the whole point of this case. It is what a deployment that never set
     * `AUDIT_RETENTION_DAYS` has, and the sweeper used to return before starting a timer at all,
     * which is how the frames went unswept everywhere the culler does not run.
     */
    const sweeps = startRetentionSweeps(databaseUrl, undefined, store, {
      firstRunMs: 10,
      intervalMs: 3_600_000,
    });
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await kept()).length === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      sweeps.stop();
    }

    expect((await kept()).map((row) => row.toolCallId)).toEqual(["turn-3"]);
  });

  test("purge removes everything past the window and nothing inside it", async () => {
    await frame(40, 1);
    await frame(29, 2);

    await store.purge(FRAME_RETENTION_MS);
    expect((await kept()).map((row) => row.toolCallId)).toEqual(["turn-2"]);
  });

  test("purge past its batch size removes every eligible row", async () => {
    for (let index = 1; index <= 205; index += 1) await frame(45, index);

    await store.purge(FRAME_RETENTION_MS);
    expect(await kept()).toHaveLength(0);
  });

  test("purge leaves a frame inside the window alone", async () => {
    await frame(1, 1);

    await store.purge(FRAME_RETENTION_MS);
    expect(await kept()).toHaveLength(1);
  });

  /*
   * Asserted on what survives for this computer rather than on what `purge` returns: the sweep is
   * deployment-wide by design, so its count moves with whatever else is in the table.
   *
   * Two replicas sweeping at once, which is the ordinary case: this half takes no advisory lock,
   * because a delete keyed on age run twice removes the same rows once. The risk it has to be shown
   * not to have is double-counting or deadlocking on the same `ctid`s.
   */
  test("two sweeps at once remove each row once and neither stalls", async () => {
    for (let index = 1; index <= 400; index += 1) await frame(45, index);

    await Promise.all([
      store.purge(FRAME_RETENTION_MS),
      store.purge(FRAME_RETENTION_MS),
    ]);

    expect(await kept()).toHaveLength(0);
  });
});
