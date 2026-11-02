import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { HANDOFF_KIND } from "../src/agents/handoff";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  type ChannelActivityEvent,
  createChannelEventHub,
  startChannelActivityListener,
} from "../src/channels/events";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  routineRuns,
  routines,
  users,
  workItems,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * What a conversation is waiting on, read from the rows that already say so.
 *
 * A Bot it asked is a `work_items` row until the hop is finished; a routine firing into it is a
 * `routine_runs` row until it has an outcome. These tests write those rows the way the queue and
 * the routine sweep do and read the answer back, because the list is a query over them and the
 * only way to know the query is right is to run it.
 */

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const store = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);

const testPrefix = `channel-work-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];
const createdRoutineIds: string[] = [];

afterEach(async () => {
  await database
    .delete(workItems)
    .where(like(workItems.key, `%${testPrefix}%`));
  for (const routineId of createdRoutineIds.splice(0)) {
    await database.delete(routines).where(eq(routines.id, routineId));
  }
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
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
    name: "Channel Work Test User",
  });
  createdUserIds.push(id);
  return { id, role: "user" };
}

async function createAgent(owner: AgentActor, name: string) {
  const profile = await profileStore.create(owner, {
    name,
    title: "Research",
    roleDescription: "Find things out.",
    visibility: "private",
  });
  createdAgentIds.push(profile.id);
  return profile.id;
}

async function setup() {
  const owner = await createUser();
  const asker = await createAgent(owner, "Assistant");
  const channel = await store.create(owner, [asker]);
  createdChannelIds.push(channel.id);
  return { owner, asker, channel };
}

/** A hop, as `handoff.ts` offers it and the queue then moves it. */
async function hop(input: {
  threadId: string;
  toBotId?: string;
  toName?: string;
  key?: string;
  answerIn?: string;
  fromBotId?: string;
  attempts?: number;
  claimed?: boolean;
  finished?: boolean;
  createdAt?: Date;
}) {
  const key = input.key ?? `hop:${testPrefix}:${randomUUID()}`;
  await database.insert(workItems).values({
    kind: HANDOFF_KIND,
    key,
    payload: {
      fromBotId: input.fromBotId ?? "assistant",
      toBotId: input.toBotId ?? "ana",
      ...(input.toName ? { toName: input.toName } : {}),
      actorId: "someone",
      threadId: input.threadId,
      runId: "run-1",
      depth: 1,
      task: "find the outage window",
      ...(input.answerIn ? { answerIn: input.answerIn } : {}),
    },
    attempts: input.attempts ?? 0,
    ...(input.claimed
      ? {
          claimedBy: "replica-a",
          leaseUntil: sql`now() + interval '1 minute'`,
        }
      : {}),
    ...(input.finished ? { finishedAt: new Date() } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  });
  return key;
}

async function workFor(
  owner: AgentActor,
  channel: { id: string; threadId: string },
) {
  return (await store.workIn(owner, [channel])).get(channel.id) ?? [];
}

/** A second person in the channel, with a thread of their own in it, as `group.ts` adds one. */
async function addMember(channelId: string) {
  const member = await createUser();
  const threadId = `${testPrefix}-thread-${randomUUID()}`;
  await database
    .insert(channelMemberships)
    .values({ channelId, userId: member.id });
  await database
    .insert(intelligenceChannelMappings)
    .values({ userId: member.id, channelId, threadId });
  return { member, channel: { id: channelId, threadId } };
}

/** Hear what the activity socket would carry to each of these people. */
async function listen(people: AgentActor[]) {
  const heard = new Map<string, ChannelActivityEvent[]>(
    people.map((person) => [person.id, []]),
  );
  const hub = createChannelEventHub();
  const detachers = people.map((person) =>
    hub.register(person.id, (payload) => {
      heard.get(person.id)?.push(JSON.parse(payload) as ChannelActivityEvent);
    }),
  );
  const listener = await startChannelActivityListener(databaseUrl, hub);
  return {
    heard,
    async until(
      count: (heard: Map<string, ChannelActivityEvent[]>) => boolean,
    ) {
      const deadline = Date.now() + 5_000;
      while (!count(heard) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async stop() {
      for (const detach of detachers) detach();
      await listener.stop();
    },
  };
}

describe("what a conversation is waiting on", () => {
  test("a Bot it asked, from the moment the hop is queued", async () => {
    const { owner, channel } = await setup();
    const key = await hop({ threadId: channel.threadId, toName: "Ana" });

    const work = await workFor(owner, channel);

    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      kind: "handoff",
      key,
      botId: "ana",
      botName: "Ana",
    });
    expect(work[0]?.since).toBeInstanceOf(Date);
  });

  test("nothing, once the hop is finished", async () => {
    const { owner, channel } = await setup();
    await hop({ threadId: channel.threadId, finished: true });

    expect(await workFor(owner, channel)).toEqual([]);
  });

  test("one entry for a hop however many times it was tried", async () => {
    const { owner, channel } = await setup();
    await hop({ threadId: channel.threadId, attempts: 3 });

    expect(await workFor(owner, channel)).toHaveLength(1);
  });

  test("two Bots asked at once are two entries, oldest first", async () => {
    const { owner, channel } = await setup();
    await hop({
      threadId: channel.threadId,
      toBotId: "ben",
      createdAt: new Date(Date.now() - 1_000),
    });
    await hop({
      threadId: channel.threadId,
      toBotId: "ana",
      createdAt: new Date(Date.now() - 5_000),
    });

    const work = await workFor(owner, channel);

    expect(work.map((entry) => entry.botId)).toEqual(["ana", "ben"]);
  });

  test("not a hop that was given up on, nor the notice saying so", async () => {
    const { owner, channel } = await setup();
    const key = await hop({ threadId: channel.threadId, attempts: 5 });
    await hop({
      threadId: channel.threadId,
      key: `notice:${key}`,
      answerIn: channel.threadId,
    });

    expect(await workFor(owner, channel)).toEqual([]);
  });

  test("a given-up hop's last attempt, while it is still running", async () => {
    const { owner, channel } = await setup();
    await hop({ threadId: channel.threadId, attempts: 5, claimed: true });

    expect(await workFor(owner, channel)).toHaveLength(1);
  });

  test("an answer on its way back is the same wait, with the same clock", async () => {
    const { owner, channel } = await setup();
    const askedAt = new Date(Date.now() - 30_000);
    const key = await hop({
      threadId: channel.threadId,
      toName: "Ana",
      finished: true,
      createdAt: askedAt,
    });
    await hop({
      threadId: channel.threadId,
      key: `relay:${key}`,
      fromBotId: "ana",
      toBotId: "assistant",
      answerIn: channel.threadId,
    });

    const work = await workFor(owner, channel);

    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      kind: "handoff",
      key,
      botId: "ana",
      botName: "Ana",
    });
    expect(work[0]?.since.getTime()).toBe(askedAt.getTime());
  });

  test("not once the answer is being given", async () => {
    const { owner, channel } = await setup();
    const key = await hop({ threadId: channel.threadId, finished: true });
    await hop({
      threadId: channel.threadId,
      key: `relay:${key}`,
      answerIn: channel.threadId,
      claimed: true,
    });

    expect(await workFor(owner, channel)).toEqual([]);
  });

  test("not a hop asked from a thread no conversation shows", async () => {
    const { owner, channel } = await setup();
    await hop({ threadId: `scratch-${testPrefix}` });

    expect(await workFor(owner, channel)).toEqual([]);
  });

  test("a routine firing into it, until the run has an outcome", async () => {
    const { owner, asker, channel } = await setup();
    const routineId = `${testPrefix}-routine`;
    await database.insert(routines).values({
      id: routineId,
      ownerUserId: owner.id,
      agentId: asker,
      channelId: channel.id,
      instruction: "Post the standup summary.",
      cron: "0 9 * * *",
      nextRunAt: new Date(Date.now() + 86_400_000),
    });
    createdRoutineIds.push(routineId);
    const runId = `${testPrefix}-run`;
    await database.insert(routineRuns).values({ id: runId, routineId });

    const running = await workFor(owner, channel);
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({
      kind: "routine",
      key: runId,
      routineId,
      botId: asker,
    });

    await database
      .update(routineRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(routineRuns.id, runId));
    expect(await workFor(owner, channel)).toEqual([]);
  });
  test("only what this person's own thread and routines wait on, in a shared channel", async () => {
    const { owner, asker, channel } = await setup();
    const { member, channel: theirs } = await addMember(channel.id);
    await hop({ threadId: channel.threadId, toName: "Ana" });
    const routineId = `${testPrefix}-routine-shared`;
    await database.insert(routines).values({
      id: routineId,
      ownerUserId: owner.id,
      agentId: asker,
      channelId: channel.id,
      instruction: "Post the standup summary.",
      cron: "0 9 * * *",
      nextRunAt: new Date(Date.now() + 86_400_000),
    });
    createdRoutineIds.push(routineId);
    await database
      .insert(routineRuns)
      .values({ id: `${testPrefix}-run-shared`, routineId });

    expect(await workFor(owner, channel)).toHaveLength(2);
    // The other member's read names neither the Bot the owner asked nor the owner's routine.
    expect(await workFor(member, theirs)).toEqual([]);
  });
});

/*
 * Every busy event carries the whole list, read at the moment it is sent, so the newest event is
 * the answer a reload would get. Heard through the real NOTIFY path, because that is the path that
 * has a size limit and a serialiser.
 */
describe("announcing it", () => {
  test("a busy signal carries the list, and the settle after the hop clears it", async () => {
    const { owner, channel } = await setup();
    const heard: ChannelActivityEvent[] = [];
    const hub = createChannelEventHub();
    const detach = hub.register(owner.id, (payload) => {
      heard.push(JSON.parse(payload) as ChannelActivityEvent);
    });
    const listener = await startChannelActivityListener(databaseUrl, hub);
    try {
      const key = await hop({ threadId: channel.threadId, toName: "Ana" });
      await store.signalBusy(channel.threadId, true);
      await database
        .update(workItems)
        .set({ finishedAt: new Date() })
        .where(eq(workItems.key, key));
      await store.signalWork(channel.threadId);

      const deadline = Date.now() + 5_000;
      while (heard.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(heard).toHaveLength(2);
      expect(heard[0]).toMatchObject({ channelId: channel.id, busy: true });
      expect(heard[0]?.work).toEqual([
        expect.objectContaining({
          kind: "handoff",
          key,
          botName: "Ana",
          since: expect.any(String),
        }),
      ]);
      // A settle says what is left without claiming a turn started or ended.
      expect(heard[1]).toMatchObject({ channelId: channel.id, work: [] });
      expect(heard[1]).toBeDefined();
      expect(heard[1]).not.toHaveProperty("busy");
    } finally {
      detach();
      await listener.stop();
    }
  });

  test("another member hears that a turn moved, and nothing about whom it asked", async () => {
    const { owner, channel } = await setup();
    const { member } = await addMember(channel.id);
    const socket = await listen([owner, member]);
    try {
      await hop({ threadId: channel.threadId, toName: "Ana" });
      await store.signalBusy(channel.threadId, true);
      await store.signalWork(channel.threadId);
      await socket.until(
        (heard) =>
          (heard.get(owner.id)?.length ?? 0) >= 2 &&
          (heard.get(member.id)?.length ?? 0) >= 1,
      );

      const ownerHeard = socket.heard.get(owner.id) ?? [];
      const memberHeard = socket.heard.get(member.id) ?? [];
      expect(ownerHeard).toHaveLength(2);
      expect(ownerHeard[0]?.work).toHaveLength(1);
      expect(ownerHeard[0]?.workAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      // Stamped in the order they were read, so a browser can drop the older of two.
      expect(
        (ownerHeard[0]?.workAt ?? "") < (ownerHeard[1]?.workAt ?? ""),
      ).toBe(true);
      // The settle is the owner's alone; the busy signal reaches the member without the list.
      expect(memberHeard).toHaveLength(1);
      expect(memberHeard[0]).toMatchObject({
        channelId: channel.id,
        busy: true,
      });
      expect(memberHeard[0]).not.toHaveProperty("work");
    } finally {
      await socket.stop();
    }
  });
});
