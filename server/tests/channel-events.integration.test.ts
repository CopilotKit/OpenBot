import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  type ChannelActivityEvent,
  type ChannelEventHub,
  createChannelEventHub,
  startChannelActivityListener,
} from "../src/channels/events";
import {
  ChannelNotFoundError,
  ChannelPackageOwnedError,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channels,
  deploymentPackages,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

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
const createdPackageIds: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const packageId of createdPackageIds.splice(0)) {
    await database
      .delete(deploymentPackages)
      .where(eq(deploymentPackages.id, packageId));
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

async function createTestUser(name: string): Promise<AgentActor> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name,
  });
  createdUserIds.push(id);
  return { id, role: "user" };
}

/** A channel with two members, which is what makes "who hears this" a question worth asking. */
async function createSharedChannel(owner: AgentActor, other: AgentActor) {
  const profile = await profileStore.create(owner, {
    name: "Expense Manager",
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    visibility: "public",
  });
  createdAgentIds.push(profile.id);
  const channel = await store.create(owner, [profile.id]);
  createdChannelIds.push(channel.id);
  // `create` writes the creator's membership only; the second member is added directly, with the
  // thread mapping the roster join requires.
  await database.insert(channelMemberships).values({
    channelId: channel.id,
    userId: other.id,
  });
  await database.insert(intelligenceChannelMappings).values({
    userId: other.id,
    channelId: channel.id,
    // thread_id is globally unique, so the second member's mapping needs one of its own.
    threadId: randomUUID(),
  });
  return channel;
}

/** Collect what each person's connection hears, and a promise that settles when one of them does. */
function watch(hub: ChannelEventHub, userIds: string[]) {
  const heard = new Map<string, ChannelActivityEvent[]>();
  let announce = () => {};
  const anything = new Promise<void>((resolve) => {
    announce = resolve;
  });
  for (const userId of userIds) {
    heard.set(userId, []);
    hub.register(userId, (payload) => {
      heard.get(userId)?.push(JSON.parse(payload));
      announce();
    });
  }
  const of = (userId: string) => heard.get(userId) ?? [];
  return { of, anything };
}

function within5s(arrived: Promise<void>) {
  return Promise.race([
    arrived,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("no event within 5s")), 5000),
    ),
  ]);
}

/**
 * Two changes a roster has to hear about that are not a message: a channel that is gone, and a pin.
 *
 * They differ in who is owed the news. A deletion hides the channel for everybody in it, so every
 * member's tabs need telling; a pin belongs to one member's own membership row, so telling anybody
 * else would show them a pin they did not make.
 */
describe("channel change delivery", () => {
  test("announces a deleted channel to every member, exactly once", async () => {
    const owner = await createTestUser("Deleting Member");
    const other = await createTestUser("Other Member");
    const channel = await createSharedChannel(owner, other);

    const hub = createChannelEventHub();
    const watched = watch(hub, [owner.id, other.id]);
    const listener = await startChannelActivityListener(databaseUrl, hub);

    try {
      await store.softDelete(owner, channel.id);
      await within5s(watched.anything);
    } finally {
      await listener.stop();
    }

    // One announcement, heard by both members: a soft delete hides the row for everyone in it.
    expect(watched.of(owner.id)).toHaveLength(1);
    expect(watched.of(other.id)).toHaveLength(1);
    expect(watched.of(owner.id)[0]).toMatchObject({
      channelId: channel.id,
      deleted: true,
    });
    expect(watched.of(owner.id)[0]?.memberIds?.sort()).toEqual(
      [owner.id, other.id].sort(),
    );
  });

  test("announces nothing for a delete the deployment package refuses", async () => {
    const owner = await createTestUser("Refused Member");
    const [deploymentPackage] = await database
      .insert(deploymentPackages)
      .values({
        tenantId: `${testPrefix}-tenant-${randomUUID()}`,
        sourcePath: "/tmp/none",
        checksum: "0",
      })
      .returning({ id: deploymentPackages.id });
    if (!deploymentPackage) throw new Error("package row was not created");
    createdPackageIds.push(deploymentPackage.id);
    const channelId = `${testPrefix}-package-channel-${randomUUID()}`;
    await database.insert(channels).values({
      id: channelId,
      name: "Package channel",
      description: "Defined by the tenant package.",
      packageId: deploymentPackage.id,
    });
    createdChannelIds.push(channelId);
    await database
      .insert(channelMemberships)
      .values({ channelId, userId: owner.id });

    const hub = createChannelEventHub();
    const watched = watch(hub, [owner.id]);
    const listener = await startChannelActivityListener(databaseUrl, hub);

    try {
      await expect(store.softDelete(owner, channelId)).rejects.toBeInstanceOf(
        ChannelPackageOwnedError,
      );
      // The refusal rolls the transaction back, so there is nothing to wait for. A window long
      // enough for a notify that did happen to arrive is what makes the empty assertion mean
      // something.
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await listener.stop();
    }

    // The channel is still there for everybody, so telling a roster it is gone would be a lie.
    expect(watched.of(owner.id)).toEqual([]);
  });

  test("tells the pinning member's own tabs and nobody else's", async () => {
    const owner = await createTestUser("Pinning Member");
    const other = await createTestUser("Other Member");
    const channel = await createSharedChannel(owner, other);

    const hub = createChannelEventHub();
    const watched = watch(hub, [owner.id, other.id]);
    const listener = await startChannelActivityListener(databaseUrl, hub);

    try {
      await store.setPinned(owner, channel.id, true);
      await within5s(watched.anything);
    } finally {
      await listener.stop();
    }

    expect(watched.of(owner.id)).toHaveLength(1);
    expect(watched.of(owner.id)[0]).toMatchObject({
      channelId: channel.id,
      pinned: true,
      memberIds: [owner.id],
    });
    /*
     * The half worth having a test for. A pin lives on one membership row, and the hub delivers by
     * `memberIds`, so naming anybody else here would put a pin on their roster that they did not
     * make. Both members are watching the same hub through the same notify, so an event that
     * included the other member would already be in this array.
     */
    expect(watched.of(other.id)).toEqual([]);
  });

  /*
   * A write refused because the channel is deleted announces nothing either.
   *
   * The listener is attached after the delete, so the delete's own announcement is not what these
   * observe: what is being asserted is that a later report about a hidden channel is silent. A notify
   * here would send every member's browser off to refetch a roster for a row it cannot show.
   */
  test("announces nothing for activity reported on a deleted channel", async () => {
    const owner = await createTestUser("Deleted Channel Member");
    const other = await createTestUser("Other Member");
    const channel = await createSharedChannel(owner, other);
    await store.softDelete(owner, channel.id);

    const hub = createChannelEventHub();
    const watched = watch(hub, [owner.id, other.id]);
    const listener = await startChannelActivityListener(databaseUrl, hub);

    try {
      await expect(
        store.recordActivity(owner, channel.id, {
          agentId: null,
          at: new Date(),
          text: "Said into a channel that is gone.",
        }),
      ).rejects.toBeInstanceOf(ChannelNotFoundError);
      // The refusal rolls back, so there is nothing to wait for; the window is what makes an empty
      // assertion mean something.
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await listener.stop();
    }

    expect(watched.of(owner.id)).toEqual([]);
    expect(watched.of(other.id)).toEqual([]);
  });

  test("announces nothing for a pin on a deleted channel", async () => {
    const owner = await createTestUser("Pinning Member");
    const channel = await createSharedChannel(
      owner,
      await createTestUser("Other Member"),
    );
    await store.softDelete(owner, channel.id);

    const hub = createChannelEventHub();
    const watched = watch(hub, [owner.id]);
    const listener = await startChannelActivityListener(databaseUrl, hub);

    try {
      await expect(
        store.setPinned(owner, channel.id, true),
      ).rejects.toBeInstanceOf(ChannelNotFoundError);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await listener.stop();
    }

    expect(watched.of(owner.id)).toEqual([]);
  });

  test("announces an unpin the same way", async () => {
    const owner = await createTestUser("Unpinning Member");
    const other = await createTestUser("Other Member");
    const channel = await createSharedChannel(owner, other);
    await store.setPinned(owner, channel.id, true);

    const hub = createChannelEventHub();
    const watched = watch(hub, [owner.id, other.id]);
    const listener = await startChannelActivityListener(databaseUrl, hub);

    try {
      await store.setPinned(owner, channel.id, false);
      await within5s(watched.anything);
    } finally {
      await listener.stop();
    }

    expect(watched.of(owner.id)).toHaveLength(1);
    expect(watched.of(owner.id)[0]).toMatchObject({
      channelId: channel.id,
      pinned: false,
    });
    expect(watched.of(other.id)).toEqual([]);
  });
});
