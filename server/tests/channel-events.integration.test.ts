import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  announceNotification,
  type ChannelActivityEvent,
  createChannelEventHub,
  type NotificationEvent,
  startLiveEventListener,
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
    type: "channel.activity",
    channelId: "channel_1",
    recipientIds: ["user-1"],
    lastMessage: "Said something.",
    lastMessageAt: "2026-08-15T10:00:00.000Z",
    lastMessageAgentId: null,
    ...overrides,
  } satisfies ChannelActivityEvent;
}

function notification(overrides: Partial<NotificationEvent> = {}) {
  return {
    type: "notification",
    recipientIds: ["user-1"],
    notification: {
      id: "notification-1",
      kind: "help_requested",
      botId: "risk-analyst",
      headline: "needs you at the keyboard",
      detail: "This page is asking for a code sent to your phone.",
      at: "2026-08-15T10:00:00.000Z",
    },
    ...overrides,
  } satisfies NotificationEvent;
}

describe("channel event hub", () => {
  test("delivers only to the members of the channel", () => {
    const hub = createChannelEventHub();
    const member: string[] = [];
    const stranger: string[] = [];
    hub.register("user-1", (payload) => member.push(payload));
    hub.register("user-2", (payload) => stranger.push(payload));

    hub.deliver(event({ recipientIds: ["user-1"] }));

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

  /**
   * A notification is addressed to one person, not to a channel's membership, and it rides the same
   * socket. Both facts are load-bearing: the first is the whole rule about who gets interrupted, and
   * the second is why the browser has to be able to tell one kind of event from the other.
   */
  test("delivers a notification only to the person it names", () => {
    const hub = createChannelEventHub();
    const waiting: string[] = [];
    const somebodyElse: string[] = [];
    hub.register("user-1", (payload) => waiting.push(payload));
    hub.register("user-2", (payload) => somebodyElse.push(payload));

    hub.deliver(notification({ recipientIds: ["user-1"] }));

    expect(waiting).toHaveLength(1);
    expect(somebodyElse).toEqual([]);
  });

  test("says which kind of event it is, on the wire", () => {
    const hub = createChannelEventHub();
    const received: string[] = [];
    hub.register("user-1", (payload) => received.push(payload));

    hub.deliver(event());
    hub.deliver(notification());

    expect(received.map((payload) => JSON.parse(payload).type)).toEqual([
      "channel.activity",
      "notification",
    ]);
  });

  test("a notification carries the Bot a click has to land on", () => {
    const hub = createChannelEventHub();
    const received: string[] = [];
    hub.register("user-1", (payload) => received.push(payload));

    hub.deliver(notification());

    const delivered = JSON.parse(received[0] as string) as NotificationEvent;
    // Without this the interruption costs the attention and then makes the person go looking, which
    // is worse than not having interrupted them.
    expect(delivered.notification.botId).toBe("risk-analyst");
    expect(delivered.notification.detail).toBe(
      "This page is asking for a code sent to your phone.",
    );
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
describe("live event delivery", () => {
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
    const listener = await startLiveEventListener(databaseUrl, hub);

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
      type: "channel.activity",
      channelId: channel.id,
      lastMessage: "Categorized three expenses.",
      lastMessageAgentId: profile.id,
      recipientIds: [owner.id],
    });
  });

  /**
   * The same round trip for a notification, which is the one that had to work across processes to be
   * worth building: the person is connected to whichever instance answered their upgrade, and the
   * handover that raises the notification is served by whichever instance answered that request.
   * Nothing arranges for those to be the same one.
   */
  test("announces a notification to a listener on its own connection", async () => {
    const id = `${testPrefix}-user-${randomUUID()}`;
    await database.insert(users).values({
      id,
      email: `${id}@example.test`,
      name: "Notification Test User",
    });
    createdUserIds.push(id);

    const hub = createChannelEventHub();
    const delivered: NotificationEvent[] = [];
    const arrived = new Promise<void>((resolve) => {
      hub.register(id, (payload) => {
        delivered.push(JSON.parse(payload));
        resolve();
      });
    });
    const listener = await startLiveEventListener(databaseUrl, hub);

    try {
      await announceNotification(
        database,
        notification({ recipientIds: [id] }),
      );
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
    expect(delivered[0]?.notification.botId).toBe("risk-analyst");
  });
});
