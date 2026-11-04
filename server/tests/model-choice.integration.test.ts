import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createModelChoices,
  ModelChoiceError,
} from "../src/channels/model-choice";
import { createDatabase } from "../src/db/client";
import {
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import type { ModelCatalogueReader } from "../src/model-catalogue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * One person's model pick per conversation: saved through the route's store, read back by the run
 * by thread, and only ever the person's own.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `model-choice-${randomUUID()}`;
const createdUsers: string[] = [];
const createdChannels: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannels.splice(0))
    await database.delete(channels).where(eq(channels.id, channelId));
  for (const userId of createdUsers.splice(0))
    await database.delete(users).where(eq(users.id, userId));
});

afterAll(async () => {
  await database.$client.close();
});

async function person() {
  const id = `${prefix}-user-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Model Choice" });
  createdUsers.push(id);
  return id;
}

/** A conversation the person is in, with their own thread. */
async function conversation(userId: string) {
  const channelId = `${prefix}-channel-${randomUUID()}`;
  const threadId = `${prefix}-thread-${randomUUID()}`;
  await database
    .insert(channels)
    .values({ id: channelId, name: "Test", description: "test" });
  createdChannels.push(channelId);
  await database.insert(channelMemberships).values({ channelId, userId });
  await database
    .insert(intelligenceChannelMappings)
    .values({ userId, channelId, threadId });
  return { channelId, threadId };
}

function choices(
  options: {
    offered?: string[];
    provider?: "openai" | "anthropic";
    on?: () => boolean;
  } = {},
) {
  const offered = options.offered ?? ["gpt-5.5", "gpt-4o", "o3"];
  return createModelChoices({
    database,
    model: { provider: options.provider ?? "openai", defaultModel: "gpt-5.5" },
    catalogue: {
      allows: async (id: string) => offered.includes(id),
    } as unknown as ModelCatalogueReader,
    enabled: options.on ?? (() => true),
  });
}

describe("a person's model pick for a conversation", () => {
  test("starts on the configured model, and a run then uses the pick", async () => {
    const userId = await person();
    const { channelId, threadId } = await conversation(userId);
    const store = choices();

    expect(await store.read(userId, channelId)).toBeNull();
    expect(await store.forRun(userId, threadId)).toBeUndefined();

    expect(await store.save(userId, channelId, "gpt-4o")).toBe("gpt-4o");
    expect(await store.read(userId, channelId)).toBe("gpt-4o");
    expect(await store.forRun(userId, threadId)).toBe("gpt-4o");
  });

  test("picking the configured model forgets the pick", async () => {
    const userId = await person();
    const { channelId, threadId } = await conversation(userId);
    const store = choices();
    await store.save(userId, channelId, "gpt-4o");

    expect(await store.save(userId, channelId, "gpt-5.5")).toBeNull();
    expect(await store.forRun(userId, threadId)).toBeUndefined();
  });

  test("a model OpenBot does not offer is refused, and nothing is saved", async () => {
    const userId = await person();
    const { channelId } = await conversation(userId);
    const store = choices();

    const refused = await store
      .save(userId, channelId, "gpt-image-2")
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ModelChoiceError);
    expect((refused as ModelChoiceError).status).toBe(400);
    expect(await store.read(userId, channelId)).toBeNull();
  });

  test("while picking is off nothing is saved or used, and turning it back on brings the pick back", async () => {
    const userId = await person();
    const { channelId, threadId } = await conversation(userId);
    let on = true;
    const store = choices({ on: () => on });
    await store.save(userId, channelId, "gpt-4o");

    on = false;
    expect(await store.forRun(userId, threadId)).toBeUndefined();
    expect(await store.read(userId, channelId)).toBeNull();
    const refused = await store
      .save(userId, channelId, "o3")
      .catch((error: unknown) => error);
    expect((refused as ModelChoiceError).status).toBe(403);

    on = true;
    expect(await store.forRun(userId, threadId)).toBe("gpt-4o");
  });

  test("a pick no longer offered is not used", async () => {
    const userId = await person();
    const { channelId, threadId } = await conversation(userId);
    await choices().save(userId, channelId, "gpt-4o");

    const narrowed = choices({ offered: ["gpt-5.5"] });
    expect(await narrowed.forRun(userId, threadId)).toBeUndefined();
    expect(await narrowed.read(userId, channelId)).toBeNull();
  });

  test("a pick made under another provider is not sent to this one", async () => {
    const userId = await person();
    const { channelId, threadId } = await conversation(userId);
    await choices().save(userId, channelId, "gpt-4o");

    const anthropic = choices({ provider: "anthropic", offered: ["gpt-4o"] });
    expect(await anthropic.forRun(userId, threadId)).toBeUndefined();
  });

  test("is only ever the person's own", async () => {
    const owner = await person();
    const stranger = await person();
    const { channelId, threadId } = await conversation(owner);
    const store = choices();
    await store.save(owner, channelId, "gpt-4o");

    for (const attempt of [
      store.read(stranger, channelId),
      store.save(stranger, channelId, "o3"),
    ]) {
      const refused = await attempt.catch((error: unknown) => error);
      expect((refused as ModelChoiceError).status).toBe(404);
    }
    expect(await store.forRun(stranger, threadId)).toBeUndefined();
    expect(await store.read(owner, channelId)).toBe("gpt-4o");
  });
});
