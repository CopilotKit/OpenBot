import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createScheduleClient } from "../src/schedules/client";
import {
  createScheduleDirectory,
  type ScheduleDirectory,
} from "../src/schedules/directory";
import { testIntelligence } from "./support/bots";

/**
 * Two server instances' schedule directories on one Intelligence, across its realtime gateway.
 *
 * A routine written through one instance reaches the other's memory by Intelligence's announcement,
 * not by the timer (set to an hour here so it cannot be what delivers it): created, changed, deleted
 * and purged, each within seconds. This is what keeps the sweep on every replica reading the same
 * routines without asking Intelligence on every pass.
 */
const started: ScheduleDirectory[] = [];
const made: string[] = [];

function instance(): ScheduleDirectory {
  const intelligence = testIntelligence();
  const directory = createScheduleDirectory({
    client: createScheduleClient(intelligence),
    gatewayWsUrl: intelligence.gatewayWsUrl,
    resyncIntervalMs: 60 * 60 * 1_000,
  });
  started.push(directory);
  return directory;
}

afterAll(async () => {
  const client = createScheduleClient(testIntelligence());
  for (const id of made) await client.purge("routines", id);
  for (const directory of started) directory.stop();
});

async function until(
  what: string,
  condition: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`${what} did not happen within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("announcements between instances", () => {
  test("a routine written on one instance reaches the other's memory without asking", async () => {
    const writer = instance();
    const reader = instance();
    await Promise.all([writer.start(), reader.start()]);
    await until("both instances subscribing", () =>
      [writer, reader].every((directory) => directory.subscribed()),
    );

    const id = `routine_${randomUUID()}`;
    made.push(id);
    const now = new Date();
    const created = await writer.create("routines", {
      id,
      ownerUserId: `announce-${randomUUID()}`,
      agentId: `bot-${randomUUID()}`,
      channelId: `channel-${randomUUID()}`,
      instruction: "Post the standup.",
      cron: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      enabledAt: now,
      nextRunAt: new Date(now.getTime() + 86_400_000),
      lastRunAt: null,
    });
    await until("the reader hearing the create", () =>
      Boolean(reader.peek("routines", id)),
    );

    const changed = await writer.update("routines", id, created.version, {
      enabled: false,
    });
    await until(
      "the reader hearing the change",
      () => reader.peek("routines", id)?.version === changed.version,
    );
    expect(reader.peek("routines", id)?.enabled).toBe(false);

    await writer.remove("routines", id);
    await until(
      "the reader hearing the delete",
      () => reader.peek("routines", id)?.deletedAt instanceof Date,
    );

    await writer.purge("routines", id);
    await until(
      "the reader hearing the purge",
      () => reader.peek("routines", id) === undefined,
    );
  }, 30_000);
});
