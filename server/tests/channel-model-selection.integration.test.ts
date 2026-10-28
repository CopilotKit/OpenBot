import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createChannelModelStore } from "../src/channels/model-selection";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const db = createDatabase(testDatabaseUrl(), TEST_POOL);
afterAll(async () => {
  await db.$client.close();
});
test("persists per-user channel choice and refuses foreign, deleted and revoked mappings", async () => {
  const id = randomUUID();
  const actor = { id, role: "user" as const };
  const bot = `bot-${id}`;
  const channel = `channel-${id}`;
  const thread = `thread-${id}`;
  const base = { provider: "openai" as const, defaultModel: "gpt-5.5" };
  let visible = true;
  const deps = {
    database: db,
    model: base,
    resolveApiKey: async () => "synthetic",
    loadAgents: async () =>
      visible
        ? [
            {
              id: bot,
              name: "Test",
              type: "built_in" as const,
              systemPrompt: "Test",
            },
          ]
        : [],
  };
  const store = createChannelModelStore(deps);
  const old = process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_BASE_URL;
  try {
    await db
      .insert(users)
      .values({ id, name: "Test", email: `${id}@test.invalid` });
    await db
      .insert(agents)
      .values({ id: bot, name: "Test", type: "built_in", configuration: {} });
    await db.insert(agentProfiles).values({
      agentId: bot,
      title: "Test",
      roleDescription: "Test",
      avatarSeed: bot,
      ownerUserId: id,
      visibility: "private",
    });
    await db
      .insert(channels)
      .values({ id: channel, name: "Test", description: "Test" });
    await db.insert(channelAgents).values({ channelId: channel, agentId: bot });
    await db
      .insert(channelMemberships)
      .values({ channelId: channel, userId: id });
    await db
      .insert(intelligenceChannelMappings)
      .values({ channelId: channel, userId: id, threadId: thread });
    expect((await store.read(actor, channel, bot)).selectedModel).toBeNull();
    await store.write(actor, channel, bot, "gpt-6-luna");
    expect(
      (await createChannelModelStore(deps).read(actor, channel, bot))
        .selectedModel,
    ).toBe("gpt-6-luna");
    expect((await store.readForRun(actor, bot, thread)).defaultModel).toBe(
      "gpt-6-luna",
    );
    expect(await store.readForRun(actor, bot, "unrelated-thread")).toBe(base);
    await expect(
      store.read({ id: "other", role: "user" }, channel, bot),
    ).rejects.toThrow();
    await expect(
      store.write(actor, channel, "other-bot", null),
    ).rejects.toThrow();
    await expect(
      store.readForRun({ id: "other", role: "user" }, bot, thread),
    ).rejects.toThrow();
    visible = false;
    await expect(store.read(actor, channel, bot)).rejects.toThrow();
    visible = true;
    process.env.OPENAI_BASE_URL = "https://custom.invalid/v1";
    expect((await store.read(actor, channel, bot)).selectionUnavailable).toBe(
      true,
    );
    await expect(store.readForRun(actor, bot, thread)).rejects.toThrow();
    expect(
      (await store.write(actor, channel, bot, null)).selectedModel,
    ).toBeNull();
    delete process.env.OPENAI_BASE_URL;
    await db
      .delete(channelMemberships)
      .where(eq(channelMemberships.channelId, channel));
    await expect(store.readForRun(actor, bot, thread)).rejects.toThrow();
  } finally {
    if (old === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = old;
    await db.delete(channels).where(eq(channels.id, channel));
    await db.delete(agents).where(eq(agents.id, bot));
    await db.delete(users).where(eq(users.id, id));
  }
});
