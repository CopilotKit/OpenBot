import { afterEach, describe, expect, test } from "bun:test";
import { startRetentionSweeps } from "../src/audit-retention";
import {
  createPageFrameStore,
  FRAME_RETENTION_MS,
} from "../src/computer/page-frames";
import { filesClient } from "../src/files/client";
import { testDatabaseUrl } from "./support/database";
import { useTestFiles } from "./support/files";

/**
 * The screenshots have to be able to stop growing, in every deployment rather than in one.
 *
 * Their reaper had a single caller, `scripts/cull-idle-computers.ts`, which refuses to run unless the
 * provider is `sandbox` and is scheduled only by the chart's culler CronJob, which renders only in
 * that mode. Compose, the all-in-one image and the chart's own default of `computers.mode: shared`
 * therefore wrote a row per navigation and removed none, ever.
 *
 * Against a real Intelligence because the frames live in its file store, and the retention is both
 * each frame's own expiry there and the sweep's delete by age.
 */

const databaseUrl = testDatabaseUrl();
useTestFiles();
const store = createPageFrameStore();

const COMPUTER = `frame-retention-${crypto.randomUUID().slice(0, 8)}`;

async function frame(daysAgo: number, index: number): Promise<void> {
  await store.save({
    computerId: COMPUTER,
    toolCallId: `turn-${index}`,
    url: `https://example.com/${index}`,
    title: `page ${index}`,
    frame: "iVBORw0KGgo=",
    capturedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
  });
}

/**
 * Many old frames, written a few at a time: each is an upload to Intelligence, and one at a time
 * four hundred of them outlast a test's default timeout.
 */
async function frames(daysAgo: number, count: number): Promise<void> {
  const indexes = Array.from({ length: count }, (_, index) => index + 1);
  for (let start = 0; start < indexes.length; start += 20) {
    await Promise.all(
      indexes.slice(start, start + 20).map((index) => frame(daysAgo, index)),
    );
  }
}

const kept = async () =>
  (
    await filesClient().list({ purpose: "page_frame", collection: COMPUTER })
  ).map((file) => ({ toolCallId: file.key }));

afterEach(async () => {
  await filesClient().purge({ purpose: "page_frame", collection: COMPUTER });
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
    await frames(45, 205);

    await store.purge(FRAME_RETENTION_MS);
    expect(await kept()).toHaveLength(0);
  }, 60_000);

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
    await frames(45, 400);

    await Promise.all([
      store.purge(FRAME_RETENTION_MS),
      store.purge(FRAME_RETENTION_MS),
    ]);

    expect(await kept()).toHaveLength(0);
  }, 60_000);
});
