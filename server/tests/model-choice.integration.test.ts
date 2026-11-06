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
import { createModelCatalogue } from "../src/model-catalogue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * One person's model and effort pick per conversation: saved through the route's store, read back by
 * the run by thread, and only ever the person's own. The catalogue is the real one, reading OpenAI's
 * own listing and models.dev as captured on 2026-11-05 (tests/fixtures/model-listings/).
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

const FIXTURES = `${import.meta.dir}/fixtures/model-listings/`;
const listing = await Bun.file(`${FIXTURES}openai-models.json`).json();
const modelsDev = await Bun.file(`${FIXTURES}models-dev-api.json`).json();

function choices(
  options: {
    /** An admin allowlist, as `openai/<id>`. Absent: everything listed. */
    allowed?: string[];
    provider?: "openai" | "anthropic";
    on?: () => boolean;
  } = {},
) {
  const model = {
    provider: options.provider ?? ("openai" as const),
    defaultModel: "gpt-5.5",
  };
  const catalogue = createModelCatalogue({
    model,
    apiKey: async () => "synthetic-key",
    environment: {},
    fetch: (async (url: string | URL | Request) =>
      Response.json(
        String(url) === "https://models.dev/api.json" ? modelsDev : listing,
      )) as typeof fetch,
    allowlist: () =>
      options.allowed
        ? { enabled: true, models: options.allowed }
        : { enabled: false, models: [] },
  });
  return createModelChoices({
    database,
    model,
    catalogue,
    enabled: options.on ?? (() => true),
  });
}

const NOTHING = { model: null, effort: null };

describe("a person's model pick for a conversation", () => {
  test("starts on the default, the middle of the current line, and a run then uses the pick", async () => {
    const userId = await person();
    const { channelId, threadId } = await conversation(userId);
    const store = choices();

    expect(await store.read(userId, channelId)).toEqual(NOTHING);
    expect(await store.forRun(userId, threadId)).toEqual({
      model: "gpt-6.1-terra",
      listed: true,
    });

    expect(
      await store.save(userId, channelId, {
        model: "gpt-6.1-sol",
        effort: "high",
      }),
    ).toEqual({ model: "gpt-6.1-sol", effort: "high" });
    expect(await store.read(userId, channelId)).toEqual({
      model: "gpt-6.1-sol",
      effort: "high",
    });
    expect(await store.forRun(userId, threadId)).toEqual({
      model: "gpt-6.1-sol",
      effort: "high",
      listed: true,
    });
  });

  test("an effort alone, on the default model", async () => {
    const userId = await person();
    const { channelId, threadId } = await conversation(userId);
    const store = choices();
    expect(
      await store.save(userId, channelId, { model: null, effort: "max" }),
    ).toEqual({ model: null, effort: "max" });
    expect(await store.forRun(userId, threadId)).toEqual({
      model: "gpt-6.1-terra",
      effort: "max",
      listed: true,
    });
  });

  test("picking the default model and its own effort forgets the pick", async () => {
    const userId = await person();
    const { channelId, threadId } = await conversation(userId);
    const store = choices();
    await store.save(userId, channelId, { model: "gpt-4o", effort: null });

    expect(
      await store.save(userId, channelId, {
        model: "gpt-6.1-terra",
        effort: null,
      }),
    ).toEqual(NOTHING);
    expect(await store.forRun(userId, threadId)).toEqual({
      model: "gpt-6.1-terra",
      listed: true,
    });
  });

  test("a model OpenBot does not offer is refused, and nothing is saved", async () => {
    const userId = await person();
    const { channelId } = await conversation(userId);
    const store = choices();

    const refused = await store
      .save(userId, channelId, { model: "gpt-image-2", effort: null })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ModelChoiceError);
    expect((refused as ModelChoiceError).status).toBe(400);
    expect(await store.read(userId, channelId)).toEqual(NOTHING);
  });

  test("an effort the model does not take is refused, and nothing is saved", async () => {
    const userId = await person();
    const { channelId } = await conversation(userId);
    const store = choices();
    for (const picked of [
      // GPT-6.1 Sol takes no `none`.
      { model: "gpt-6.1-sol", effort: "none" },
      // GPT-4o is not a reasoning model.
      { model: "gpt-4o", effort: "high" },
    ]) {
      const refused = await store
        .save(userId, channelId, picked)
        .catch((error: unknown) => error);
      expect((refused as ModelChoiceError).status).toBe(400);
    }
    expect(await store.read(userId, channelId)).toEqual(NOTHING);
  });

  test("while picking is off nothing is saved or used, and turning it back on brings the pick back", async () => {
    const userId = await person();
    const { channelId, threadId } = await conversation(userId);
    let on = true;
    const store = choices({ on: () => on });
    await store.save(userId, channelId, { model: "gpt-4o", effort: null });

    on = false;
    expect(await store.forRun(userId, threadId)).toEqual({
      model: "gpt-6.1-terra",
      listed: true,
    });
    expect(await store.read(userId, channelId)).toEqual(NOTHING);
    const refused = await store
      .save(userId, channelId, { model: "o3", effort: null })
      .catch((error: unknown) => error);
    expect((refused as ModelChoiceError).status).toBe(403);

    on = true;
    expect((await store.forRun(userId, threadId)).model).toBe("gpt-4o");
  });

  test("a pick no longer offered is not used", async () => {
    const userId = await person();
    const { channelId, threadId } = await conversation(userId);
    await choices().save(userId, channelId, { model: "gpt-4o", effort: null });

    const narrowed = choices({ allowed: ["openai/gpt-6.1-terra"] });
    expect((await narrowed.forRun(userId, threadId)).model).toBe(
      "gpt-6.1-terra",
    );
    expect(await narrowed.read(userId, channelId)).toEqual(NOTHING);
  });

  test("a pick made under another provider is not sent to this one", async () => {
    const userId = await person();
    const { channelId, threadId } = await conversation(userId);
    await choices().save(userId, channelId, { model: "gpt-4o", effort: null });

    const anthropic = choices({ provider: "anthropic" });
    expect((await anthropic.forRun(userId, threadId)).model).not.toBe("gpt-4o");
  });

  test("is only ever the person's own", async () => {
    const owner = await person();
    const stranger = await person();
    const { channelId, threadId } = await conversation(owner);
    const store = choices();
    await store.save(owner, channelId, { model: "gpt-4o", effort: null });

    for (const attempt of [
      store.read(stranger, channelId),
      store.save(stranger, channelId, { model: "o3", effort: null }),
    ]) {
      const refused = await attempt.catch((error: unknown) => error);
      expect((refused as ModelChoiceError).status).toBe(404);
    }
    expect((await store.forRun(stranger, threadId)).model).toBe(
      "gpt-6.1-terra",
    );
    expect(await store.read(owner, channelId)).toEqual({
      model: "gpt-4o",
      effort: null,
    });
  });
});
