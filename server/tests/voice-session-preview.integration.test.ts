import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SaveVoiceSessionInput } from "@openbot/shared/voice-session";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AppVariables } from "../src/auth/guards";
import {
  type ChannelActivityEvent,
  createChannelEventHub,
} from "../src/channels/events";
import { deliverConversationChanges } from "../src/channels/live";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { createVoiceSessionRoutes } from "../src/voice/session-routes";
import { createVoiceSessionStore } from "../src/voice/sessions";
import type { VoiceSummarizer } from "../src/voice/summary";
import { removeBots, useTestBots } from "./support/bots";
import {
  eventually,
  purgeConversations,
  storedConversation,
  useTestConversations,
} from "./support/conversations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profiles,
  createThreadIdentity("voice-preview-test"),
);
const store = createVoiceSessionStore(channelStore);
const owner = { id: `voice-preview-${randomUUID()}`, role: "user" } as const;
const channelIds: string[] = [];
let agentId: string;
const hub = createChannelEventHub();
const delivered: ChannelActivityEvent[] = [];
let stopLive: (() => void) | undefined;
hub.register(owner.id, (payload) => {
  delivered.push(JSON.parse(payload));
});

beforeAll(async () => {
  await useTestBots();
  await database.insert(users).values({
    id: owner.id,
    email: `${owner.id}@example.test`,
    name: "Voice preview test",
  });
  const profile = await profiles.create(owner, {
    name: "Voice preview",
    title: "Assistant",
    roleDescription: "Help plan.",
    visibility: "private",
  });
  agentId = profile.id;
  // What Intelligence announces, to this hub, as the server wires it (channels/live.ts).
  stopLive = deliverConversationChanges(
    (await useTestConversations()).conversations,
    hub,
  );
});

afterAll(async () => {
  stopLive?.();
  await purgeConversations(channelIds);
  if (agentId) await removeBots([agentId]);
  await database.delete(users).where(eq(users.id, owner.id));
  await database.$client.close();
});

async function fixture() {
  const channel = await channelStore.create(owner, [agentId]);
  channelIds.push(channel.id);
  const input: SaveVoiceSessionInput = {
    id: randomUUID(),
    channelId: channel.id,
    anchorMessageId: null,
    startedAt: "2026-09-21T00:00:00.000Z",
    endedAt: "2026-09-21T00:00:45.000Z",
    transcript: [{ id: "spoken", role: "user", text: "Plan the launch." }],
  };
  function router(summarize: VoiceSummarizer) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (context, next) => {
      context.set("actor", owner);
      await next();
    });
    return app.route(
      "/sessions",
      createVoiceSessionRoutes({ store, channels: channelStore, summarize }),
    );
  }
  async function post(app: ReturnType<typeof router>) {
    const response = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-openbot-voice": "1" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    return response.json();
  }
  async function row() {
    return storedConversation(channel.id);
  }
  const failedRouter = router(async () => {
    throw new Error("Summary unavailable");
  });
  return {
    input,
    router,
    post,
    row,
    fail: () => post(failedRouter),
    events: () =>
      delivered.filter(
        (event) => event.channelId === channel.id && event.lastMessage !== null,
      ),
  };
}

test("failed summary retries enrich the durable preview and notify once across replicas", async () => {
  const f = await fixture();
  await f.fail();
  expect(await f.row()).toMatchObject({
    lastMessage: "Voice chat",
    lastMessageSourceId: `voice:${f.input.id}`,
  });
  let started = 0;
  const gate = Promise.withResolvers<void>();
  const summarize =
    (summary: string): VoiceSummarizer =>
    async () => {
      if (++started === 2) gate.resolve();
      await gate.promise;
      return summary;
    };
  const first = f.router(summarize("Discussed launch plans."));
  const second = f.router(summarize("Planned the release."));
  const responses = await Promise.all([f.post(first), f.post(second)]);
  const durable = (await store.list(owner, f.input.channelId)).sessions[0];
  expect(durable?.summaryStatus).toBe("ready");
  expect(responses.map((response) => response.session.summary)).toEqual([
    durable?.summary,
    durable?.summary,
  ]);
  expect(await f.row()).toMatchObject({
    lastMessage: `Voice chat: ${durable?.summary}`,
    lastMessageAt: new Date(f.input.endedAt),
  });
  await Promise.all([f.post(first), f.post(second)]);
  await eventually(() => f.events().length >= 2, { quietMs: 1_000 });
  expect(f.events().map((event) => event.lastMessage)).toEqual([
    "Voice chat",
    `Voice chat: ${durable?.summary}`,
  ]);
  expect(
    f.events().every((event) => event.lastMessageAt === f.input.endedAt),
  ).toBe(true);
});

test("a retry preserves and does not announce over newer conversation activity", async () => {
  const f = await fixture();
  await f.fail();
  const at = new Date(Date.parse(f.input.endedAt) + 1000);
  await channelStore.recordActivity(owner, f.input.channelId, {
    text: "A newer message",
    agentId,
    at,
  });
  await f.post(f.router(async () => "Discussed launch plans."));
  await eventually(() => f.events().length >= 2, { quietMs: 1_000 });
  expect(await f.row()).toMatchObject({
    lastMessage: "A newer message",
    lastMessageAt: at,
    lastMessageSourceId: null,
  });
  expect(f.events().map((event) => event.lastMessage)).toEqual([
    "Voice chat",
    "A newer message",
  ]);
});

test("equal timestamps and placeholder text cannot enrich another source's activity", async () => {
  for (const source of [undefined, { id: `voice:${randomUUID()}` }]) {
    const f = await fixture();
    await channelStore.recordActivity(
      owner,
      f.input.channelId,
      { text: "Voice chat", agentId: null, at: new Date(f.input.endedAt) },
      source,
    );
    await f.fail();
    await f.post(f.router(async () => "Discussed launch plans."));
    await eventually(() => f.events().length >= 1, { quietMs: 1_000 });
    expect(await f.row()).toMatchObject({
      lastMessage: "Voice chat",
      lastMessageSourceId: source?.id ?? null,
    });
    expect(f.events()).toHaveLength(1);
  }
});
