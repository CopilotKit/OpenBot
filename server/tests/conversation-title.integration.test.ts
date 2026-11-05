import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { untitledLine } from "@openbot/shared/conversation-title";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  type ChannelActivityEvent,
  createChannelEventHub,
  startChannelActivityListener,
} from "../src/channels/events";
import {
  createChannelRoutes,
  createChannelStore,
} from "../src/channels/routes";
import {
  CHANNEL_SUMMARY_KIND,
  type ChannelTitler,
  summariseClaimedChannels,
  type ThreadTranscript,
} from "../src/channels/summary";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createChannelTitler } from "../src/channels/titler";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  users,
  workItems,
} from "../src/db/schema";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * What a new conversation is called in the sidebar, from the person's first message to its name.
 *
 * Found on a fresh install: two conversations were called by the Bot's answer, Markdown and all.
 * "Use your web search tool ... latest released version of kubectl" read `The latest stable
 * **kubectl** release is…` until it was named a minute later, and a status update asked for in a
 * learned skill's format read `STATUS: green - Done: Worker secret…`. The namer was not at fault:
 * asked about either conversation, the model names it. The sidebar draws the name once there is one
 * and, until then, the channel's last message, which by then was the Bot's reply, stored as written.
 *
 * Real: PostgreSQL, the channel store and its HTTP routes (the browser's activity report and its
 * roster read), the live event hub on LISTEN/NOTIFY, the naming sweep, and the titler calling a model
 * endpoint over HTTP that answers with OpenAI's own recorded bodies. Faked: the Intelligence
 * platform's message read, shaped as it stores a turn that called a tool before answering.
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
const suite = `conversation-title-${randomUUID().slice(0, 8)}`;

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

/**
 * One recorded exchange with OpenAI: what the titler asked, and the body OpenAI answered with.
 *
 * Recorded 2026-11-05 from `api.openai.com/v1/chat/completions` with `gpt-5.6-terra`, the model a
 * vanilla install names conversations with, by `createChannelTitler` itself sending these excerpts.
 */
type Recording = { excerpt: string; body: string };

/** OpenAI's body as it arrived, byte for byte: the fixture is the response, not a rewrite of it. */
const recorded = (name: string) =>
  readFileSync(
    new URL(`./fixtures/openai-wire/${name}`, import.meta.url),
    "utf8",
  );

/** An OpenAI-compatible endpoint that answers each excerpt it was recorded for, and refuses the rest. */
function startRecordedEndpoint(recordings: Recording[]) {
  const asked: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/v1/chat/completions"
      )
        return new Response(null, { status: 404 });
      const body = (await request.json()) as {
        messages?: { role?: string; content?: unknown }[];
      };
      const excerpt = String(
        body.messages?.find((message) => message.role === "user")?.content,
      );
      asked.push(excerpt);
      const recording = recordings.find((each) => each.excerpt === excerpt);
      // Loud, not a guess: an excerpt nobody recorded has no real answer to replay.
      if (!recording)
        return Response.json(
          { error: { message: `Nothing recorded for: ${excerpt}` } },
          { status: 500 },
        );
      return new Response(recording.body, {
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    asked,
    stop: () => server.stop(true),
  };
}

/** The browser's side of the conversation: its activity reports and its roster read. */
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
    /** What `recordChannelActivityMutationOptions` posts when a line is said in the conversation. */
    async report(
      channelId: string,
      line: { text: string; agentId: string | null; at: Date },
    ) {
      const response = await app.request(
        `/api/channels/${channelId}/activity`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...line, at: line.at.toISOString() }),
        },
      );
      expect(response.status).toBe(204);
    },
    /** The row the sidebar draws, from the roster it reads. */
    async row(channelId: string) {
      const response = await app.request("/api/channels?limit=50");
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        channels: {
          id: string;
          summary: string | null;
          opening?: string | null;
          lastMessage: string | null;
        }[];
      };
      const row = body.channels.find((channel) => channel.id === channelId);
      if (!row) throw new Error(`The roster has no ${channelId}.`);
      return row;
    },
  };
}

/** The second line of a sidebar row, as `components/app-sidebar/channel.tsx` draws it. */
function sidebarLine(row: {
  summary: string | null;
  opening?: string | null;
  lastMessage: string | null;
}) {
  return row.summary || untitledLine(row) || "New conversation";
}

async function personWithBot() {
  const id = `${suite}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Conversation Title Test User",
  });
  createdUserIds.push(id);
  const person: AuthenticatedActor = {
    id,
    email: `${id}@example.test`,
    role: "user",
  };
  const bot = await profileStore.create(person, {
    name: "General Assistant",
    title: "Assistant",
    roleDescription: "Help with anything.",
    visibility: "private",
  });
  createdAgentIds.push(bot.id);
  const channel = await store.create(person, [bot.id]);
  createdChannelIds.push(channel.id);
  return { person, botId: bot.id, channel };
}

/**
 * The thread as the platform stores it: the person's message, the Bot's tool call (the card, or
 * loading the skill), the tool's result, and then the answer.
 */
function threadOf(
  threadId: string,
  turn: { asked: string; toolCall: string; answered: string },
): ThreadTranscript {
  return {
    getThreadMessages: async (params) => {
      expect(params.threadId).toBe(threadId);
      return {
        messages: [
          { role: "user", content: turn.asked },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call-1",
                type: "function",
                function: { name: turn.toolCall, arguments: "{}" },
              },
            ],
          },
          { role: "tool", content: "{}" },
          { role: "assistant", content: turn.answered },
        ],
      };
    },
  };
}

/** Name the one conversation, by its own queue row, the way the server's sweep does. */
async function nameIt(
  channelId: string,
  transcript: ThreadTranscript,
  title: ChannelTitler,
) {
  await queue.offer({ kind: CHANNEL_SUMMARY_KIND, key: channelId });
  return await summariseClaimedChannels({
    database,
    queue,
    transcript,
    title,
    owner: `${suite}-${randomUUID()}`,
  });
}

const KUBECTL = {
  asked:
    "Use your web search tool (not your browser) to find the latest released version of kubectl, and cite the source URL.",
  // The run that asked for Parallel Search ended on its card; the answer came after it was pressed.
  toolCall: "request_app",
  answered:
    "The latest stable **kubectl** release is **v1.37.2**, from the [Kubernetes releases page](https://kubernetes.io/releases/).\n\nSource: https://kubernetes.io/releases/",
  recording: "chat-title-kubectl.json",
  named: "Latest Kubectl Release Version",
};

const STATUS = {
  asked:
    "Give me a team status update for the routines fix. Done: Worker secret generated once and kept, routines on by default. Blocked: nothing. Next: live check on a fresh install. Owner: Claude.",
  // A Skill published by Automatic Learning, loaded before answering in the format it teaches.
  toolCall: "copilotkit_load_skill",
  answered:
    "STATUS: green\n- Done: Worker secret generated once and kept, routines on by default\n- Blocked: nothing\n- Next: live check on a fresh install\n- Owner: Claude",
  recording: "chat-title-status.json",
  named: "Routines Fix Team Status",
};

describe("a new conversation in the sidebar", () => {
  for (const [label, turn] of [
    ["the kubectl search answered after a card", KUBECTL],
    ["the status update answered in a learned Skill's format", STATUS],
  ] as const) {
    test(`${label} is called by what was asked, then by its name, never by the answer`, async () => {
      const { person, botId, channel } = await personWithBot();
      const browser = browserFor(person);
      const hub = createChannelEventHub();
      const listener = await startChannelActivityListener(databaseUrl, hub);
      const delivered: ChannelActivityEvent[] = [];
      const detach = hub.register(person.id, (payload) => {
        const event = JSON.parse(payload) as ChannelActivityEvent;
        if (event.channelId === channel.id) delivered.push(event);
      });
      const endpoint = startRecordedEndpoint([
        {
          excerpt: `Asked: ${turn.asked}`,
          body: recorded(turn.recording),
        },
      ]);
      try {
        const now = Date.now();
        await browser.report(channel.id, {
          text: turn.asked,
          agentId: null,
          at: new Date(now - 10_000),
        });
        await browser.report(channel.id, {
          text: turn.answered,
          agentId: botId,
          at: new Date(now - 5_000),
        });

        // Before it is named: the person's own words, not the Bot's reply.
        const unnamed = await browser.row(channel.id);
        expect(unnamed.summary).toBeNull();
        expect(sidebarLine(unnamed)).toBe(turn.asked.slice(0, 59).concat("…"));
        expect(sidebarLine(unnamed)).not.toContain("*");
        // And the reply, wherever it is still drawn as the last thing said, is plain text.
        expect(unnamed.lastMessage).not.toContain("**");
        expect(unnamed.lastMessage).not.toContain("](");

        // An open sidebar is told the same, without a reload.
        const openings = () =>
          delivered.flatMap((event) =>
            event.opening === undefined ? [] : [event.opening],
          );
        for (let waited = 0; openings().length === 0 && waited < 2_000; ) {
          await Bun.sleep(50);
          waited += 50;
        }
        expect(openings()).toEqual([sidebarLine(unnamed)]);

        const report = await nameIt(
          channel.id,
          threadOf(channel.threadId, turn),
          createChannelTitler({
            model: "gpt-5.6-terra",
            resolveApiKey: async () => "test-key",
            environment: { OPENAI_BASE_URL: endpoint.baseUrl },
          }),
        );
        expect(report.written).toContain(channel.id);
        expect(endpoint.asked).toEqual([`Asked: ${turn.asked}`]);

        // Named: OpenAI's own answer, as the name.
        const named = await browser.row(channel.id);
        expect(named.summary).toBe(turn.named);
        expect(sidebarLine(named)).toBe(turn.named);
      } finally {
        detach();
        await listener.stop();
        await endpoint.stop();
      }
    });
  }
});

describe("what the namer answers", () => {
  test("a reply to the conversation is not written as its name", async () => {
    const { person, botId, channel } = await personWithBot();
    const browser = browserFor(person);
    const now = Date.now();
    await browser.report(channel.id, {
      text: STATUS.asked,
      agentId: null,
      at: new Date(now - 10_000),
    });
    await browser.report(channel.id, {
      text: STATUS.answered,
      agentId: botId,
      at: new Date(now - 5_000),
    });

    // A model that did what the conversation asked instead of naming it: the Bot's own answer.
    const report = await nameIt(
      channel.id,
      threadOf(channel.threadId, STATUS),
      async () => STATUS.answered,
    );

    expect(report.written).not.toContain(channel.id);
    const row = await browser.row(channel.id);
    expect(row.summary).toBeNull();
    expect(sidebarLine(row)).toStartWith("Give me a team status update");
  });

  test("a name written in Markdown is written as plain text", async () => {
    const { person, channel } = await personWithBot();
    const browser = browserFor(person);
    await browser.report(channel.id, {
      text: KUBECTL.asked,
      agentId: null,
      at: new Date(Date.now() - 1_000),
    });

    await nameIt(
      channel.id,
      threadOf(channel.threadId, KUBECTL),
      async () => "**Latest `kubectl` release**",
    );

    expect((await browser.row(channel.id)).summary).toBe(
      "Latest kubectl release",
    );
  });
});
