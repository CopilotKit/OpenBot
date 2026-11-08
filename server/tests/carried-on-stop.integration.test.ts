import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  announceCarriedOnStop,
  type CarriedOnStopListener,
  createCarriedOnTurns,
  startCarriedOnStopListener,
} from "../src/approvals/carried-on";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A person's Stop reaches the carried-on turn on whichever replica runs it.
 *
 * The resume loop's turn runs on the replica that claimed the work, and the Stop arrives at the
 * replica that answered the person's request, which is rarely the same one. Two replicas here, each
 * with its own carried-on turns and its own listener, on the real PostgreSQL every replica shares.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const listeners: CarriedOnStopListener[] = [];

afterAll(async () => {
  await Promise.all(listeners.map((listener) => listener.stop()));
  await database.$client.close();
});

async function replica() {
  const turns = createCarriedOnTurns({
    announce: announceCarriedOnStop(database),
  });
  listeners.push(await startCarriedOnStopListener(testDatabaseUrl(), turns));
  return turns;
}

test("a Stop answered by one replica stops the carried-on turn another replica runs", async () => {
  const answering = await replica();
  const running = await replica();
  const threadId = `thread-${randomUUID()}`;

  let started!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const turn = running.run(
    threadId,
    (signal) =>
      new Promise<string>((_resolve, reject) => {
        started();
        signal.addEventListener("abort", () =>
          reject(new Error("The headless turn was cancelled.")),
        );
      }),
    () => "stopped",
  );
  await begun;

  // Not running here, so it is announced, and the replica running it stops it.
  await answering.stop(threadId);
  expect(await turn).toBe("stopped");
});

test("a Stop for another conversation leaves this one running", async () => {
  const answering = await replica();
  const running = await replica();
  const threadId = `thread-${randomUUID()}`;
  let stopped = false;
  const controller = new AbortController();
  const turn = running.run(
    threadId,
    (signal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => {
          stopped = true;
          resolve("aborted");
        });
        controller.signal.addEventListener("abort", () => resolve("answered"));
      }),
    () => "stopped",
  );

  await answering.stop(`thread-${randomUUID()}`);
  // Long enough for the announcement to have gone round both replicas.
  await Bun.sleep(300);
  expect(stopped).toBe(false);
  controller.abort();
  expect(await turn).toBe("answered");
});
