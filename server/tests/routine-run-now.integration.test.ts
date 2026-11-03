import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AgentActor } from "../src/agents/profile-types";
import { createDatabase } from "../src/db/client";
import { routines, users } from "../src/db/schema";
import {
  createRoutineStore,
  RoutineNotFoundError,
  RoutineRefusedError,
} from "../src/routines/store";
import { removeBots, seedBot } from "./support/bots";
import { purgeConversations, seedConversation } from "./support/conversations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const store = createRoutineStore(database);

const testPrefix = `routine-run-now-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

/** Every day at 09:00 UTC: comfortably above the floor and stable to describe. */
const DAILY = "0 9 * * *";

afterEach(async () => {
  // Routines go with their owner (a cascade) and with their Bot when it is purged, but they are
  // cleared first so a failure part-way through cleanup leaves nothing pointing at rows this file
  // is about to delete.
  for (const userId of createdUserIds) {
    await database.delete(routines).where(eq(routines.ownerUserId, userId));
  }
  await purgeConversations(createdChannelIds.splice(0));
  await removeBots(createdAgentIds.splice(0));
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function createUser(): Promise<AgentActor> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Routine Store Test User",
  });
  createdUserIds.push(id);
  return { id, role: "user" };
}

// The channel is seeded directly: this suite only needs what the routine store's own channel check
// reads, a live conversation with the owner as a member and the Bot in it.
async function createAgent(owner: AgentActor) {
  const id = `${testPrefix}-agent-${randomUUID()}`;
  createdAgentIds.push(id);
  await seedBot({
    id,
    name: "Run Now Bot",
    type: "built_in",
    ownerUserId: owner.id,
  });
  return id;
}

async function createChannel(owner: AgentActor, agentIds: string[]) {
  const id = `${testPrefix}-channel-${randomUUID()}`;
  createdChannelIds.push(id);
  await seedConversation({
    id,
    name: "Run now",
    description: "",
    agentIds,
    members: [{ userId: owner.id, threadId: null }],
  });
  return { id };
}

describe("Run now and run history", () => {
  test("opens one run at a time, lists newest first, and refuses paused or foreign routines", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);
    const routine = await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Summarize the day.",
      cron: DAILY,
    });

    const first = await store.startManualRun(owner.id, routine.id);
    await expect(store.startManualRun(owner.id, routine.id)).rejects.toThrow(
      /already running/,
    );
    await store.finishRun(first.runId, "succeeded");
    const second = await store.startManualRun(owner.id, routine.id);

    const runs = await store.listRuns(owner.id, routine.id);
    expect(runs.map((run) => run.id)).toEqual([second.runId, first.runId]);
    expect(runs[0]?.status).toBeNull();
    expect(runs[1]?.status).toBe("succeeded");
    expect(runs.map((run) => run.source)).toEqual(["run_now", "run_now"]);
    const scheduled = await store.insertRun(routine.id);
    await store.finishRun(scheduled.runId, "skipped");
    expect(
      (await store.listRuns(owner.id, routine.id)).find(
        (run) => run.id === scheduled.runId,
      )?.source,
    ).toBe("schedule");
    expect((await store.runContext(second.runId))?.enabled).toBe(true);

    await expect(
      store.listRuns(stranger.id, routine.id),
    ).rejects.toBeInstanceOf(RoutineNotFoundError);
    await expect(
      store.startManualRun(stranger.id, routine.id),
    ).rejects.toBeInstanceOf(RoutineNotFoundError);

    await store.finishRun(second.runId, "failed", "boom");
    await store.setEnabled(owner.id, routine.id, false);
    await expect(
      store.startManualRun(owner.id, routine.id),
    ).rejects.toBeInstanceOf(RoutineRefusedError);
    expect((await store.runContext(second.runId))?.enabled).toBe(false);
  });
});
