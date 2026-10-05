import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { SaveVoiceSessionInput } from "../../shared/voice-session";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
  voiceSessions,
} from "../src/db/schema";
import { createVoiceSessionStore } from "../src/voice/sessions";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profiles,
  createThreadIdentity("voice-store-test"),
);
const store = createVoiceSessionStore(database, channelStore);
const prefix = `voice-${randomUUID()}`;
const owner = { id: `${prefix}-owner`, role: "user" } as const;
const member = { id: `${prefix}-member`, role: "user" } as const;
const outsider = { id: `${prefix}-outsider`, role: "user" } as const;
let channelId: string;
let agentId: string;

beforeAll(async () => {
  for (const actor of [owner, member, outsider])
    await database.insert(users).values({
      id: actor.id,
      email: `${actor.id}@example.test`,
      name: "Voice store test",
    });
  const profile = await profiles.create(owner, {
    name: "Voice test",
    title: "Assistant",
    roleDescription: "Help with planning.",
    visibility: "public",
  });
  agentId = profile.id;
  const channel = await channelStore.create(owner, [profile.id]);
  channelId = channel.id;
  await database
    .insert(channelMemberships)
    .values({ channelId, userId: member.id });
  await database
    .insert(intelligenceChannelMappings)
    .values({ channelId, userId: member.id, threadId: randomUUID() });
});

afterAll(async () => {
  if (channelId)
    await database.delete(channels).where(eq(channels.id, channelId));
  if (agentId) await database.delete(agents).where(eq(agents.id, agentId));
  await database
    .delete(users)
    .where(inArray(users.id, [owner.id, member.id, outsider.id]));
  await database.$client.close();
});

function input(id = randomUUID()): SaveVoiceSessionInput {
  return {
    id: `${prefix}-${id}`,
    channelId,
    anchorMessageId: null,
    startedAt: "2026-09-21T00:00:00.000Z",
    endedAt: "2026-09-21T00:00:45.000Z",
    transcript: [{ id: "turn-1", role: "user", text: "Plan the launch." }],
  };
}

test("sessions persist as JSON, are immutable/idempotent, and are shared only with channel members", async () => {
  const request = input();
  const saved = await store.save(owner, request);
  expect(saved.durationSeconds).toBe(45);
  expect(saved.summaryStatus).toBe("failed");
  expect(await store.save(owner, request)).toEqual(saved);
  expect((await store.list(member, channelId)).sessions).toContainEqual(saved);
  await expect(store.list(outsider, channelId)).rejects.toThrow(
    "Channel not found",
  );
  await expect(store.save(outsider, input())).rejects.toThrow(
    "Channel not found",
  );
  await expect(store.save(member, request)).rejects.toThrow("already in use");
  await expect(
    store.save(owner, {
      ...request,
      transcript: [{ id: "changed", role: "user", text: "Changed" }],
    }),
  ).rejects.toThrow("already in use");
  await expect(
    store.summarize(member, request.id, "Forged summary"),
  ).rejects.toThrow("not found");
  const summary = await store.summarize(
    owner,
    request.id,
    "Discussed launch plans; nothing executed.",
  );
  expect(summary.summaryStatus).toBe("ready");
  expect((await store.save(owner, request)).summary).toBe(summary.summary);
  const [row] = await database
    .select()
    .from(voiceSessions)
    .where(eq(voiceSessions.id, request.id));
  expect(row?.transcript.entries).toEqual(request.transcript);
});

test("pagination handles equal timestamps without missing or repeating sessions", async () => {
  for (let index = 0; index < 51; index++)
    await store.save(owner, input(`page-${String(index).padStart(3, "0")}`));
  const first = await store.list(owner, channelId);
  expect(first.sessions).toHaveLength(50);
  expect(first.nextCursor).not.toBeNull();
  const second = await store.list(
    owner,
    channelId,
    first.nextCursor ?? undefined,
  );
  expect(second.nextCursor).toBeNull();
  const all = [...first.sessions, ...second.sessions];
  expect(new Set(all.map(({ id }) => id)).size).toBe(all.length);
  expect(all.filter(({ id }) => id.includes("-page-"))).toHaveLength(51);
  await expect(store.list(owner, channelId, "not-a-cursor")).rejects.toThrow(
    "Invalid voice history cursor",
  );
});

test("deleted agents make voice writes inactive while existing history stays readable", async () => {
  await database
    .update(agentProfiles)
    .set({ deletedAt: new Date() })
    .where(eq(agentProfiles.agentId, agentId));
  await expect(store.save(owner, input())).rejects.toThrow("no longer active");
  expect((await store.list(owner, channelId)).sessions.length).toBeGreaterThan(
    0,
  );
});
