import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { SaveVoiceSessionInput } from "../../shared/voice-session";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AppVariables } from "../src/auth/guards";
import {
  CHANNEL_ACTIVITY_TOPIC,
  type ChannelActivityEvent,
  createChannelEventHub,
  startChannelActivityListener,
} from "../src/channels/events";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import { agents, channels, users } from "../src/db/schema";
import { createVoiceSessionRoutes } from "../src/voice/session-routes";
import { createVoiceSessionStore } from "../src/voice/sessions";
import type { VoiceSummarizer } from "../src/voice/summary";
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
const store = createVoiceSessionStore(database, channelStore);
const owner = { id: `voice-preview-${randomUUID()}`, role: "user" } as const;
const channelIds: string[] = [];
let agentId: string;
const hub = createChannelEventHub();
const delivered: ChannelActivityEvent[] = [];
const barriers = new Map<string, () => void>();
let listener: Awaited<ReturnType<typeof startChannelActivityListener>>;
hub.register(owner.id, (payload) => {
  const event: ChannelActivityEvent = JSON.parse(payload);
  const resolve = barriers.get(event.channelId);
  if (resolve) resolve();
  else delivered.push(event);
});

beforeAll(async () => {
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
  listener = await startChannelActivityListener(databaseUrl, hub);
});

afterAll(async () => {
  await listener?.stop();
  if (channelIds.length)
    await database.delete(channels).where(inArray(channels.id, channelIds));
  if (agentId) await database.delete(agents).where(eq(agents.id, agentId));
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
    const [result] = await database
      .select()
      .from(channels)
      .where(eq(channels.id, channel.id));
    return result;
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

/** A later NOTIFY on the same topic confirms the listener consumed all preceding committed writes. */
async function flushNotifications() {
  const id = `barrier-${randomUUID()}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arrived = new Promise<void>((resolve, reject) => {
    barriers.set(id, resolve);
    timer = setTimeout(
      () => reject(new Error("Channel notifications did not arrive")),
      5000,
    );
  });
  try {
    const event: ChannelActivityEvent = {
      channelId: id,
      memberIds: [owner.id],
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
    };
    await database.execute(
      sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify(event)})`,
    );
    await arrived;
  } finally {
    clearTimeout(timer);
    barriers.delete(id);
  }
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
  await flushNotifications();
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
  await flushNotifications();
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
    await flushNotifications();
    expect(await f.row()).toMatchObject({
      lastMessage: "Voice chat",
      lastMessageSourceId: source?.id ?? null,
    });
    expect(f.events()).toHaveLength(1);
  }
});
