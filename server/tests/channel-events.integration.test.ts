import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
import { TEST_POOL } from "./support/database";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";

function event(overrides: Partial<ChannelActivityEvent> = {}) {
  return {
    channelId: "channel_1",
    memberIds: ["user-1"],
    lastMessage: "Said something.",
    lastMessageAt: "2026-08-15T10:00:00.000Z",
    lastMessageAgentId: null,
    ...overrides,
  } satisfies ChannelActivityEvent;
}

describe("channel event hub", () => {
  test("delivers only to the members of the channel", () => {
    const hub = createChannelEventHub();
    const member: string[] = [];
    const stranger: string[] = [];
    hub.register("user-1", (payload) => member.push(payload));
    hub.register("user-2", (payload) => stranger.push(payload));

    hub.deliver(event({ memberIds: ["user-1"] }));

    expect(member).toHaveLength(1);
    expect(JSON.parse(member[0] as string).lastMessage).toBe("Said something.");
    // Membership is what authorises delivery, so somebody outside the channel hears nothing.
    expect(stranger).toEqual([]);
  });

  test("reaches every connection a person has open", () => {
    const hub = createChannelEventHub();
    const received: string[] = [];
    hub.register("user-1", (payload) => received.push(`tab-a:${payload}`));
    hub.register("user-1", (payload) => received.push(`tab-b:${payload}`));

    hub.deliver(event());

    expect(received).toHaveLength(2);
    expect(hub.connectionCount("user-1")).toBe(2);
  });

  test("stops delivering once a connection detaches, and forgets the person", () => {
    const hub = createChannelEventHub();
    const received: string[] = [];
    const detach = hub.register("user-1", (payload) => received.push(payload));

    detach();
    hub.deliver(event());

    expect(received).toEqual([]);
    // Dropped rather than left as an empty set, so a long-lived process does not grow one per
    // person who has ever connected.
    expect(hub.connectionCount("user-1")).toBe(0);
  });

  test("one failing connection does not deny the event to the rest", () => {
    const hub = createChannelEventHub();
    const healthy: string[] = [];
    hub.register("user-1", () => {
      throw new Error("this socket is closing");
    });
    hub.register("user-1", (payload) => healthy.push(payload));

    expect(() => hub.deliver(event())).not.toThrow();
    expect(healthy).toHaveLength(1);
  });
});

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
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
const testPrefix = `channel-events-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

afterEach(async () => {
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

/**
 * Delivery goes through Postgres so it survives more than one server instance. This proves the round
 * trip a second instance would take: a write announces, and a listener that shares nothing with the
 * writer but the database hears it.
 */
describe("channel activity delivery", () => {
  test("announces a recorded message to a listener on its own connection", async () => {
    const id = `${testPrefix}-user-${randomUUID()}`;
    await database.insert(users).values({
      id,
      email: `${id}@example.test`,
      name: "Channel Events Test User",
    });
    createdUserIds.push(id);
    const owner: AgentActor = { id, role: "user" };

    const profile = await profileStore.create(owner, {
      name: "Expense Manager",
      title: "Finance Operations",
      roleDescription: "Review receipts.",
      visibility: "private",
    });
    createdAgentIds.push(profile.id);
    const channel = await store.create(owner, [profile.id]);
    createdChannelIds.push(channel.id);

    const hub = createChannelEventHub();
    const delivered: ChannelActivityEvent[] = [];
    const arrived = new Promise<void>((resolve) => {
      hub.register(owner.id, (payload) => {
        delivered.push(JSON.parse(payload));
        resolve();
      });
    });
    const listener = await startChannelActivityListener(databaseUrl, hub);

    try {
      await store.recordActivity(owner, channel.id, {
        agentId: profile.id,
        at: new Date(),
        text: "Categorized three expenses.",
      });
      await Promise.race([
        arrived,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("no event within 5s")), 5000),
        ),
      ]);
    } finally {
      await listener.stop();
    }

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      channelId: channel.id,
      lastMessage: "Categorized three expenses.",
      lastMessageAgentId: profile.id,
      memberIds: [owner.id],
    });
  });
});
