import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createChannelStore } from "../src/channels/routes";
import {
  CHANNEL_SUMMARY_KIND,
  type ChannelTitler,
  offerChannelsAwaitingSummary,
  summariseClaimedChannels,
  type ThreadTranscript,
} from "../src/channels/summary";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
  workItems,
} from "../src/db/schema";
import { createWorkQueue } from "../src/work/queue";
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
const queue = createWorkQueue(database);

const testPrefix = `channel-summary-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database.delete(workItems).where(eq(workItems.key, channelId));
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
    name: "Channel Summary Test User",
  });
  createdUserIds.push(id);
  return { id, role: "user" };
}

async function createAgent(owner: AgentActor) {
  const profile = await profileStore.create(owner, {
    name: "Expense Manager",
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    visibility: "private",
  });
  createdAgentIds.push(profile.id);
  return profile.id;
}

/** A channel somebody has actually said something in, which is the only kind worth naming. */
async function createUsedChannel(owner: AgentActor) {
  const agentId = await createAgent(owner);
  const channel = await store.create(owner, [agentId]);
  createdChannelIds.push(channel.id);
  await store.recordActivity(owner, channel.id, {
    text: "Which of these receipts count as travel?",
    agentId: null,
    at: new Date(),
  });
  return channel;
}

/** A transcript with one question and one answer in it, which is what a title is made from. */
function transcriptOf(question: string, answer?: string): ThreadTranscript {
  return {
    getThreadMessages: async () => ({
      messages: [
        { role: "user", content: question },
        ...(answer ? [{ role: "assistant", content: answer }] : []),
      ],
    }),
  };
}

function titler(answer: string | null): ChannelTitler {
  return async () => answer;
}

async function summaryOf(channelId: string) {
  const [row] = await database
    .select({ summary: channels.summary, summaryAt: channels.summaryAt })
    .from(channels)
    .where(eq(channels.id, channelId));
  return row;
}

/**
 * Queue one conversation, by name.
 *
 * Deliberately not `offerChannelsAwaitingSummary`, which offers every unnamed conversation in the
 * database. A claim takes whatever is queued, so a test that offers the whole table and then claims
 * will happily write a fabricated title onto somebody's real conversation when the suite is pointed
 * at a database that has any — a development one, for instance. Tests that exercise the offer query
 * itself assert on what it returns and never claim.
 */
async function offer(channelId: string) {
  await queue.offer({ kind: CHANNEL_SUMMARY_KIND, key: channelId });
}

const options = (overrides: {
  transcript?: ThreadTranscript;
  title?: ChannelTitler;
  owner?: string;
}) => ({
  database,
  queue,
  transcript: overrides.transcript ?? transcriptOf("Which receipts?"),
  title: overrides.title ?? titler("Travel receipt rules"),
  owner: overrides.owner ?? `test-${randomUUID()}`,
});

describe("offering conversations to be named", () => {
  test("offers one that has been used and has no name yet", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);

    const { offered } = await offerChannelsAwaitingSummary({
      database,
      queue,
      limit: 200,
    });

    expect(offered).toContain(channel.id);
  });

  test("does not offer a channel nobody has said anything in", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await store.create(owner, [agentId]);
    createdChannelIds.push(channel.id);

    const { offered } = await offerChannelsAwaitingSummary({
      database,
      queue,
      limit: 200,
    });

    // There is nothing for a model to read, and asking it to name an empty thread spends money to
    // produce a guess.
    expect(offered).not.toContain(channel.id);
  });

  test("offering the same conversation twice leaves one piece of work", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);

    await offerChannelsAwaitingSummary({ database, queue, limit: 200 });
    await offerChannelsAwaitingSummary({ database, queue, limit: 200 });

    const rows = await database
      .select({ key: workItems.key })
      .from(workItems)
      .where(eq(workItems.key, channel.id));
    expect(rows).toHaveLength(1);
  });
});

/**
 * What the first pass on a deployment with a history looks like.
 *
 * Every conversation ever used and never named is eligible at once, so the only thing standing
 * between a deploy and a model request per historical conversation is the claim limit. These pin
 * that limit as behaviour rather than leaving it a constant somebody can raise without noticing what
 * it is holding back.
 */
describe("a backlog of unnamed conversations", () => {
  test("names at most one batch per pass, not one per conversation", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const made: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const channel = await store.create(owner, [agentId]);
      createdChannelIds.push(channel.id);
      await store.recordActivity(owner, channel.id, {
        text: `Question ${index}`,
        agentId: null,
        at: new Date(),
      });
      made.push(channel.id);
    }
    for (const id of made) await offer(id);

    let calls = 0;
    const counting = options({
      title: async () => {
        calls += 1;
        return "A title";
      },
    });

    const first = await summariseClaimedChannels({ ...counting, limit: 2 });
    expect(first.written).toHaveLength(2);
    expect(calls).toBe(2);

    const second = await summariseClaimedChannels({ ...counting, limit: 2 });
    expect(second.written).toHaveLength(2);
    // The next batch, not the first one again.
    expect(second.written.some((id) => first.written.includes(id))).toBe(false);
    expect(calls).toBe(4);
  });
});

describe("naming a claimed conversation", () => {
  test("writes the title and stamps when it was written", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    const report = await summariseClaimedChannels(
      options({
        transcript: transcriptOf(
          "Which of these receipts count as travel?",
          "The three flights and the hotel do.",
        ),
        title: titler("Travel receipt rules"),
      }),
    );

    expect(report.written).toContain(channel.id);
    const row = await summaryOf(channel.id);
    expect(row?.summary).toBe("Travel receipt rules");
    expect(row?.summaryAt).toBeInstanceOf(Date);
  });

  test("two replicas racing for the same conversation name it once", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    /*
     * Overlapping, not sequential. Two sweeps run one after the other pass just as happily with the
     * row-level locking removed, so they prove the conditional update and nothing about the claim.
     * These two are in flight together on separate pooled connections, which is what `for update
     * skip locked` is there for: the second finds nothing to take rather than waiting behind the
     * first and then doing the work twice.
     */
    const [left, right] = await Promise.all([
      summariseClaimedChannels(options({ title: titler("Left title") })),
      summariseClaimedChannels(options({ title: titler("Right title") })),
    ]);

    expect([...left.written, ...right.written]).toEqual([channel.id]);
    expect(left.considered + right.considered).toBe(1);
    const written = (await summaryOf(channel.id))?.summary;
    expect(["Left title", "Right title"]).toContain(written);
  });

  test("never overwrites a name the conversation already has", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await database
      .update(channels)
      .set({ summary: "Named already", summaryAt: new Date() })
      .where(eq(channels.id, channel.id));
    // Offered before it was named, which is exactly the race two replicas produce.
    await queue.offer({ kind: CHANNEL_SUMMARY_KIND, key: channel.id });

    await summariseClaimedChannels(
      options({ title: titler("A second opinion") }),
    );

    expect((await summaryOf(channel.id))?.summary).toBe("Named already");
  });

  test("leaves the conversation unnamed when the model has no answer", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    const report = await summariseClaimedChannels(
      options({ title: titler(null) }),
    );

    // A deployment with no model key reaches this on every pass. Nothing is written, nothing is
    // broken, and the roster keeps drawing the Bot's name.
    expect(report.written).not.toContain(channel.id);
    expect((await summaryOf(channel.id))?.summary).toBeNull();
  });

  test("comes back later when the conversation is not readable yet", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    // What a conversation looks like in the seconds between somebody sending a message and
    // Intelligence holding it. Finishing the work here is how an ordinary conversation ends up
    // never named at all.
    const report = await summariseClaimedChannels(
      options({
        transcript: { getThreadMessages: async () => ({ messages: [] }) },
      }),
    );

    expect(report.skipped).toContainEqual({
      channelId: channel.id,
      reason: "not readable yet",
    });
    const [item] = await database
      .select({ finishedAt: workItems.finishedAt, runAt: workItems.runAt })
      .from(workItems)
      .where(eq(workItems.key, channel.id));
    expect(item?.finishedAt).toBeNull();
    expect(item?.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("a conversation that no longer exists is dropped, not retried", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);
    // The channel goes while its naming is still queued. A queue key is not a foreign key, so the
    // work outlives the thing it was about — which happens for real on a delete, and happens on
    // every integration test that seeds a channel and tears it down.
    await database.delete(channels).where(eq(channels.id, channel.id));

    await summariseClaimedChannels(options({}));

    const [item] = await database
      .select({
        finishedAt: workItems.finishedAt,
        attempts: workItems.attempts,
      })
      .from(workItems)
      .where(eq(workItems.key, channel.id));
    // Finished rather than released: nothing about a deleted conversation is different in fifteen
    // seconds, and retrying it to the attempt cap burns a model call's worth of work each time.
    expect(item?.finishedAt).not.toBeNull();
    expect(item?.attempts).toBe(1);
  });

  test("a soft-deleted conversation is dropped the same way", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);
    await database
      .update(channels)
      .set({ deletedAt: new Date() })
      .where(eq(channels.id, channel.id));

    await summariseClaimedChannels(options({}));

    const [item] = await database
      .select({ finishedAt: workItems.finishedAt })
      .from(workItems)
      .where(eq(workItems.key, channel.id));
    expect(item?.finishedAt).not.toBeNull();
    expect((await summaryOf(channel.id))?.summary).toBeNull();
  });

  test("stays inside the NOTIFY payload limit on a crowded channel", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    // The title is short and fixed; the term that grows is the member list the payload carries, so
    // that is the term the test grows. `pg_notify` refuses a payload over 8000 bytes outright, and
    // it refuses it inside the transaction that writes the title.
    const crowd = [];
    for (let index = 0; index < 40; index += 1) {
      const member = await createUser();
      crowd.push(member.id);
      await database
        .insert(channelMemberships)
        .values({ channelId: channel.id, userId: member.id });
    }

    await offer(channel.id);
    const report = await summariseClaimedChannels(
      options({ title: titler("Travel receipt rules") }),
    );

    expect(report.written).toContain(channel.id);
    // Recorded rather than merely survived: this is the number that says how much room is left, and
    // it is what a later change adding a field to the event has to be measured against.
    const payload = JSON.stringify({
      channelId: channel.id,
      memberIds: [owner.id, ...crowd],
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
      summary: "Travel receipt rules",
    });
    expect(payload.length).toBeLessThan(8000);
  });

  test("a model that fails leaves the work to be tried again", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    await summariseClaimedChannels(
      options({
        title: async () => {
          throw new Error("the model is unreachable");
        },
      }),
    );

    expect((await summaryOf(channel.id))?.summary).toBeNull();
    const [item] = await database
      .select({ attempts: workItems.attempts, error: workItems.lastError })
      .from(workItems)
      .where(eq(workItems.key, channel.id));
    expect(item?.attempts).toBe(1);
    expect(item?.error).toContain("the model is unreachable");
  });

  test("flattens and shortens whatever the model answers with", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    await summariseClaimedChannels(
      options({ title: titler('  "Travel\nreceipt   rules"  ') }),
    );

    // The quotes a model wraps a title in, the newline, and the run of spaces all go: a roster row
    // is one line of plain text.
    expect((await summaryOf(channel.id))?.summary).toBe("Travel receipt rules");
  });
});
