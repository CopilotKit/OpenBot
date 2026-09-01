import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  AgentNotFoundError,
  createAgentProfileStore,
} from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  ChannelNotFoundError,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

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

const testPrefix = `channel-activity-${randomUUID()}`;
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

async function createUser(): Promise<AgentActor> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Channel Activity Test User",
  });
  createdUserIds.push(id);
  return { id, role: "user" };
}

async function createAgent(owner: AgentActor, name = "Expense Manager") {
  const profile = await profileStore.create(owner, {
    name,
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    visibility: "private",
  });
  createdAgentIds.push(profile.id);
  return profile.id;
}

async function createChannel(owner: AgentActor, agentIds: string[]) {
  const channel = await store.create(owner, agentIds);
  createdChannelIds.push(channel.id);
  return channel;
}

/**
 * The sidebar asked for every channel this person has, on every render.
 *
 * One row per channel-agent pair, and nothing removes a channel: somebody who talks to their Bot
 * daily accumulates thousands, so a query that is instant in a demo returns thousands of rows on
 * every page load, for every employee, and grows for as long as they use the product.
 *
 * The page has to be chosen over channels rather than over rows, which is the whole subtlety here: a
 * limit on rows would cut a two-Bot channel in half and its second Bot would arrive on the next page
 * as a separate entry with the same id.
 */
describe("reading a person's channels", () => {
  test("answers a page rather than everything", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    for (let index = 0; index < 5; index += 1) {
      await createChannel(owner, [agentId]);
    }

    const page = await store.list(owner, { limit: 2 });

    expect(page.channels).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  test("walking the cursor reaches every channel exactly once", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const expected: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      expected.push((await createChannel(owner, [agentId])).id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await store.list(owner, {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.channels.map((channel) => channel.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(expected.sort());
  });

  test("a channel with two Bots is never split across pages", async () => {
    /*
     * The reason the page is chosen over channels and the agents joined afterwards. Limiting the row
     * set would put the channel's first Bot on one page and its second on the next, as two entries
     * sharing an id, and the sidebar would render the same conversation twice with half its Bots.
     */
    const owner = await createUser();
    const first = await createAgent(owner, "First");
    const second = await createAgent(owner, "Second");
    const shared = await createChannel(owner, [first, second]);
    await createChannel(owner, [first]);

    const seen: { id: string; agentIds: string[] }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await store.list(owner, {
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      // One channel per page, whatever it holds. A row limit would put two here.
      expect(result.channels.length).toBeLessThanOrEqual(1);
      seen.push(...result.channels);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    // Which of the two sorts first is incidental; that the shared one arrives once and whole is not.
    const found = seen.filter((channel) => channel.id === shared.id);
    expect(found).toHaveLength(1);
    expect(found[0]?.agentIds.sort()).toEqual([first, second].sort());
  });

  test("a caller cannot ask for every channel in one page", async () => {
    // The limit arrives over HTTP, so the ceiling is what makes paging a property of the endpoint.
    const owner = await createUser();
    const agentId = await createAgent(owner);
    await createChannel(owner, [agentId]);

    const page = await store.list(owner, { limit: 100_000 });

    expect(page.channels.length).toBeLessThanOrEqual(200);
  });

  test("a nonsense cursor reads as the first page", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    await createChannel(owner, [agentId]);

    const page = await store.list(owner, { cursor: "not-a-cursor" });

    expect(page.channels).toHaveLength(1);
  });

  test("somebody with no channels gets an empty page and no cursor", async () => {
    const owner = await createUser();

    const page = await store.list(owner);

    expect(page.channels).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

/**
 * The roster reads the last thing said from our own row rather than from the Intelligence platform,
 * so it stays one indexed query however long the conversations get. What is stored is whatever the
 * client that ran the agent reported, which is why each of these guards exists.
 */
describe("channel activity", () => {
  test("records the last message and returns it on the roster", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);
    const at = new Date();

    await store.recordActivity(owner, channel.id, {
      agentId,
      at,
      text: "Categorized three expenses.",
    });

    expect((await store.list(owner)).channels).toEqual([
      {
        ...channel,
        lastMessage: "Categorized three expenses.",
        lastMessageAgentId: agentId,
        lastMessageAt: at,
        createdAt: expect.any(Date),
        hasCustomAvatars: [false],
        avatarUpdatedAts: [expect.any(Date)],
        pinned: false,
        lastReadAt: null,
      },
    ]);
  });

  test("keeps a person's roster to the channels they belong to", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    expect((await store.list(otherUser)).channels).toEqual([]);
    await expect(
      store.recordActivity(otherUser, channel.id, {
        agentId: null,
        at: new Date(),
        text: "Not mine.",
      }),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  test("ignores a report older than what is already stored", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);
    const newest = new Date();
    const older = new Date(newest.getTime() - 60_000);

    await store.recordActivity(owner, channel.id, {
      agentId,
      at: newest,
      text: "The reply.",
    });
    // A person's message and the agent's reply are two separate reports. A slow one must not
    // overwrite a newer one that already landed.
    await store.recordActivity(owner, channel.id, {
      agentId: null,
      at: older,
      text: "The question.",
    });

    expect((await store.list(owner)).channels[0]?.lastMessage).toBe(
      "The reply.",
    );
  });

  test("stores at most 200 code points, without control characters", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    await store.recordActivity(owner, channel.id, {
      agentId,
      at: new Date(),
      // A terminal escape and a newline: a preview is rendered as text, not replayed as control.
      text: `line one\nline two \u001b[31m ${"x".repeat(400)}`,
    });

    const stored = (await store.list(owner)).channels[0]?.lastMessage ?? "";
    expect(Array.from(stored).length).toBeLessThanOrEqual(200);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting they were removed.
    expect(stored).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(stored.startsWith("line one line two")).toBe(true);
  });

  test("refuses an agent that is not in the channel", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const strangerId = await createAgent(owner, "Stranger");
    const channel = await createChannel(owner, [agentId]);

    await expect(
      store.recordActivity(owner, channel.id, {
        agentId: strangerId,
        at: new Date(),
        text: "Not from this channel.",
      }),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  test("puts a channel just created above one that has already been used", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const used = await createChannel(owner, [agentId]);
    await store.recordActivity(owner, used.id, {
      agentId,
      // A minute back, not `now`. The activity time comes from this process and `created_at` comes
      // from Postgres, so two events written in the same instant are ordered by whichever clock is
      // marginally ahead. The property under test is the ordering rule, not the tie-break.
      at: new Date(Date.now() - 60_000),
      text: "Said something a minute ago.",
    });

    // Starting a conversation is the most recent thing this person did, and it is the one they are
    // about to type in. Sorting it under every channel that has a message would bury it.
    const fresh = await createChannel(owner, [agentId]);

    expect(
      (await store.list(owner)).channels.map((channel) => channel.id),
    ).toEqual([fresh.id, used.id]);
  });

  test("sorts by recency and leaves silent channels below, not absent", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const quiet = await createChannel(owner, [agentId]);
    const busy = await createChannel(owner, [agentId]);

    await store.recordActivity(owner, busy.id, {
      agentId,
      at: new Date(),
      text: "Said something.",
    });

    expect(
      (await store.list(owner)).channels.map((channel) => channel.id),
    ).toEqual([busy.id, quiet.id]);
  });
});

/**
 * A pin holds a channel at the top of the roster, which is a claim about the roster and not about
 * whichever page happens to be loaded.
 *
 * Ordering pinned-first only in the browser sorts the rows already fetched, so a channel somebody
 * pinned and then did not talk to for a month sits on page three and never appears at the top at
 * all — the roster the person sees contradicts the pin they made. The order therefore belongs in the
 * query, and the cursor has to carry the pin flag as its leading element or paging walks the same
 * channel twice.
 */
describe("a pinned channel in a paged roster", () => {
  /** Channels with explicit, minute-apart activity, newest last, so recency order is not a clock race. */
  async function channelsWithActivity(owner: AgentActor, count: number) {
    const agentId = await createAgent(owner);
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push((await createChannel(owner, [agentId])).id);
    }
    const base = Date.now() - count * 60_000;
    for (const [index, id] of ids.entries()) {
      await store.recordActivity(owner, id, {
        agentId,
        at: new Date(base + index * 60_000),
        text: `Message ${index}`,
      });
    }
    return ids;
  }

  /** Every channel the cursor reaches, in the order the pages hand them over. */
  async function walk(owner: AgentActor, limit: number) {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await store.list(owner, {
        limit,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.channels.map((channel) => channel.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return seen;
  }

  test("lifts a pinned channel onto the first page, however old it is", async () => {
    const owner = await createUser();
    const ids = await channelsWithActivity(owner, 6);
    const oldest = ids[0] as string;

    await store.setPinned(owner, oldest, true);

    // Two per page, six channels: on recency alone this one is the last row of the last page.
    const page = await store.list(owner, { limit: 2 });
    expect(page.channels.map((channel) => channel.id)[0]).toBe(oldest);
  });

  test("walks every channel exactly once across pinned and unpinned", async () => {
    const owner = await createUser();
    const ids = await channelsWithActivity(owner, 6);
    // Two pins, chosen so the group boundary does not line up with a page boundary.
    await store.setPinned(owner, ids[0] as string, true);
    await store.setPinned(owner, ids[3] as string, true);

    const seen = await walk(owner, 2);

    // Pinned first, and recency within each group: the cursor has to order pages the same way the
    // first page is ordered, or a channel is served twice and another never at all.
    expect(seen).toEqual([
      ids[3] as string,
      ids[0] as string,
      ids[5] as string,
      ids[4] as string,
      ids[2] as string,
      ids[1] as string,
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("unpinning puts the channel back where recency alone would have it", async () => {
    const owner = await createUser();
    const ids = await channelsWithActivity(owner, 4);
    const oldest = ids[0] as string;

    await store.setPinned(owner, oldest, true);
    await store.setPinned(owner, oldest, false);

    expect(await walk(owner, 2)).toEqual([
      ids[3] as string,
      ids[2] as string,
      ids[1] as string,
      oldest,
    ]);
  });
});

/**
 * The one conversation a person has with one Bot.
 *
 * A hop delivers into it, and a Bot asked for several things in one turn produces several hops at
 * once. Looking and then making is not find-or-create: each of two concurrent deliveries found
 * nothing and made a conversation, so that person had two Knowledge channels holding two threads,
 * with the answers split between them.
 */
describe("finding or making a person's channel with one Bot", () => {
  test("two at once get the same conversation, not one each", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner, "Knowledge");

    const [first, second] = await Promise.all([
      store.direct(owner, agentId),
      store.direct(owner, agentId),
    ]);
    createdChannelIds.push(first.id, second.id);

    expect(second.id).toBe(first.id);
    expect(second.threadId).toBe(first.threadId);
  });

  test("an existing conversation is reused rather than added to", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner, "Knowledge");
    const made = await createChannel(owner, [agentId]);

    const found = await store.direct(owner, agentId);

    expect(found.id).toBe(made.id);
  });

  /*
   * A channel holding this Bot and another one matches an agent test on its own. Delivering into it
   * would put a hop's answer in front of a Bot nobody had asked.
   */
  test("a channel with a second Bot in it is not that person's direct one", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner, "Knowledge");
    const other = await createAgent(owner, "Research");
    const shared = await createChannel(owner, [agentId, other]);

    const found = await store.direct(owner, agentId);
    createdChannelIds.push(found.id);

    expect(found.id).not.toBe(shared.id);
    expect(found.agentIds).toEqual([agentId]);
  });
});
