import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import postgres from "postgres";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  CHANNEL_ACTIVITY_TOPIC,
  type ChannelActivityEvent,
} from "../src/channels/events";
import {
  createChannelRoutes,
  createChannelStore,
} from "../src/channels/routes";
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
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A person renames a conversation from the sidebar, and the name is the one it keeps.
 *
 * Real: PostgreSQL, the channel store and its HTTP routes (the rename the browser sends and the
 * roster it reads back, which is what a reload draws), and the naming sweep that writes a summary.
 * Faked: the Intelligence message read and the model, which the sweep takes as seams.
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
const queue = createWorkQueue(database);
const suite = `conversation-rename-${randomUUID().slice(0, 8)}`;

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

async function person(): Promise<AuthenticatedActor> {
  const id = `${suite}-user-${randomUUID()}`;
  const email = `${id}@example.test`;
  await database.insert(users).values({ id, email, name: "Rename Test" });
  createdUserIds.push(id);
  return { id, email, role: "user" };
}

/** A conversation `owner` started with one of their Bots, with their first message in it. */
async function conversationOf(owner: AuthenticatedActor) {
  const profile = await profileStore.create(owner, {
    name: "Expense Manager",
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    visibility: "private",
  });
  createdAgentIds.push(profile.id);
  const channel = await store.create(owner, [profile.id]);
  createdChannelIds.push(channel.id);
  await store.recordActivity(owner, channel.id, {
    text: "Which of these receipts count as travel?",
    agentId: null,
    at: new Date(),
  });
  return channel.id;
}

/** The browser's side: the rename it sends, and the roster row it draws after a reload. */
function browserFor(actor: AuthenticatedActor) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/api/channels", createChannelRoutes(store, requireUser));
  return {
    /** What `renameChannelMutationOptions` sends. */
    async rename(channelId: string, title: string | null) {
      const response = await app.request(`/api/channels/${channelId}/title`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      return {
        status: response.status,
        body: (await response.json()) as { summary?: string; error?: string },
      };
    },
    async row(channelId: string) {
      const response = await app.request("/api/channels?limit=50");
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        channels: { id: string; summary: string | null; canRename: boolean }[];
      };
      const row = body.channels.find((channel) => channel.id === channelId);
      if (!row) throw new Error(`The roster has no ${channelId}.`);
      return row;
    },
  };
}

const transcript: ThreadTranscript = {
  getThreadMessages: async () => ({
    messages: [
      { role: "user", content: "Which of these receipts count as travel?" },
      { role: "assistant", content: "The taxi and the hotel do." },
    ],
  }),
};

/** One pass of the naming sweep over this conversation alone. See `offer` in channel-summary. */
async function sweep(channelId: string, title: ChannelTitler) {
  await queue.offer({ kind: CHANNEL_SUMMARY_KIND, key: channelId });
  return await summariseClaimedChannels({
    database,
    queue,
    transcript,
    title,
    owner: `test-${randomUUID()}`,
  });
}

describe("renaming a conversation", () => {
  test("the person's name survives a reload and every later summary", async () => {
    const owner = await person();
    const channelId = await conversationOf(owner);
    const browser = browserFor(owner);

    // The sweep names it first, the way it does a minute after the first message.
    await sweep(channelId, async () => "Travel receipt rules");
    expect((await browser.row(channelId)).summary).toBe("Travel receipt rules");

    const renamed = await browser.rename(channelId, "  Q3   trip\nreceipts ");
    expect(renamed.status).toBe(200);
    // One line, as the roster draws it.
    expect(renamed.body.summary).toBe("Q3 trip receipts");

    const row = await browser.row(channelId);
    expect(row.summary).toBe("Q3 trip receipts");
    expect(row.canRename).toBe(true);

    // The sweep coming round again leaves it alone, and so does a summary cleared for a redo.
    await sweep(channelId, async () => "Something the model thought of");
    await database
      .update(channels)
      .set({ summary: null })
      .where(eq(channels.id, channelId));
    // With its settled work forgotten too, so nothing but the name keeps it from being offered.
    await database.delete(workItems).where(eq(workItems.key, channelId));
    const { offered } = await offerChannelsAwaitingSummary({
      database,
      queue,
      limit: 500,
    });
    expect(offered).not.toContain(channelId);
    expect((await browser.row(channelId)).summary).toBe("Q3 trip receipts");
  });

  test("a rename made while the model is naming it wins", async () => {
    const owner = await person();
    const channelId = await conversationOf(owner);
    const browser = browserFor(owner);

    // What every member's open sidebar is told the conversation is called, as it is told it.
    const listener = postgres(databaseUrl, { max: 1 });
    const barrier = `rename-barrier-${randomUUID()}`;
    const drained = Promise.withResolvers<void>();
    const announced: (string | null)[] = [];
    try {
      await listener.listen(CHANNEL_ACTIVITY_TOPIC, (payload) => {
        if (payload === barrier) return drained.resolve();
        const event = JSON.parse(payload) as ChannelActivityEvent;
        if (event.channelId === channelId && event.summary !== undefined)
          announced.push(event.summary);
      });

      // The person renames between the sweep reading the conversation and writing its answer.
      const report = await sweep(channelId, async () => {
        expect((await browser.rename(channelId, "Expenses")).status).toBe(200);
        return "Travel receipt rules";
      });

      // NOTIFY is commit-ordered, so the barrier arriving means every announcement before it has.
      await database.execute(
        sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${barrier})`,
      );
      await drained.promise;
      expect(report.skipped).toEqual([]);
      // The model's words never reach a sidebar, not even until the next reload.
      expect(announced).toEqual(["Expenses"]);
      expect((await browser.row(channelId)).summary).toBe("Expenses");
    } finally {
      await listener.end({ timeout: 1 });
    }
  });

  test("an empty name gives the conversation back the one OpenBot chose", async () => {
    const owner = await person();
    const channelId = await conversationOf(owner);
    const browser = browserFor(owner);
    await sweep(channelId, async () => "Travel receipt rules");

    await browser.rename(channelId, "Expenses");
    const cleared = await browser.rename(channelId, "   ");

    expect(cleared.status).toBe(200);
    expect(cleared.body.summary).toBe("Travel receipt rules");
    expect((await browser.row(channelId)).summary).toBe("Travel receipt rules");
  });

  test("refuses a name longer than a sidebar title", async () => {
    const owner = await person();
    const channelId = await conversationOf(owner);
    const browser = browserFor(owner);

    const refused = await browser.rename(channelId, "x".repeat(61));

    expect(refused.status).toBe(400);
    expect((await browser.row(channelId)).summary).toBeNull();
  });
});

describe("who may rename a conversation", () => {
  test("only the person who started it, even in a conversation others are in", async () => {
    const owner = await person();
    const member = await person();
    const outsider = await person();
    const channelId = await conversationOf(owner);
    // Added the way a group adds somebody: a membership and a thread of their own.
    await database
      .insert(channelMemberships)
      .values({ channelId, userId: member.id });
    await database.insert(intelligenceChannelMappings).values({
      userId: member.id,
      channelId,
      threadId: `thread-${randomUUID()}`,
    });
    await browserFor(owner).rename(channelId, "Expenses");

    const asMember = await browserFor(member).rename(channelId, "Mine now");
    expect(asMember.status).toBe(403);
    expect(asMember.body.error).toBe(
      "Only the person who started this conversation can rename it.",
    );
    const asOutsider = await browserFor(outsider).rename(channelId, "Mine now");
    expect(asOutsider.status).toBe(404);

    // The member sees the owner's name and is not offered the rename.
    const memberRow = await browserFor(member).row(channelId);
    expect(memberRow.summary).toBe("Expenses");
    expect(memberRow.canRename).toBe(false);
    expect((await browserFor(owner).row(channelId)).summary).toBe("Expenses");
  });
});
