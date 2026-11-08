import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  createModelChoiceRoutes,
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
import {
  createModelCatalogue,
  createModelRoutes,
} from "../src/model-catalogue";
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
    /** A team's allowed models, as `openai/<id>`. Absent: one person, offered everything. */
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
    // A team's catalogue reads what an admin allowed; one person's reads none and offers all.
    ...(options.allowed
      ? {
          allowlist: () => ({
            enabled: true,
            models: options.allowed ?? [],
          }),
        }
      : {}),
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
      label: "GPT-6.1 Terra",
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
      label: "GPT-6.1 Sol",
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
      label: "GPT-6.1 Terra",
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
      label: "GPT-6.1 Terra",
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
      label: "GPT-6.1 Terra",
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

  /*
   * Whichever of the stranger's two attempts answers first. Both used to be started at once and
   * awaited in turn, so when the save was refused before the read (a slower database round trip, as
   * on a busy CI runner) its refusal had no handler yet, and the test failed on an unhandled
   * "Couldn't find that conversation." that was exactly the answer it expected. Each attempt is now
   * started where it is awaited; `slower` holds one back to pin both orders.
   */
  test.each(["read", "save"] as const)(
    "is only ever the person's own, when the stranger's %s answers last",
    async (slower) => {
      const owner = await person();
      const stranger = await person();
      const { channelId, threadId } = await conversation(owner);
      const store = choices();
      await store.save(owner, channelId, { model: "gpt-4o", effort: null });
      const held = <T>(which: "read" | "save", attempt: () => Promise<T>) =>
        which === slower
          ? new Promise((resolve) => setTimeout(resolve, 100)).then(attempt)
          : attempt();

      for (const attempt of [
        () => held("read", () => store.read(stranger, channelId)),
        () =>
          held("save", () =>
            store.save(stranger, channelId, { model: "o3", effort: null }),
          ),
      ]) {
        const refused = await attempt().catch((error: unknown) => error);
        expect((refused as ModelChoiceError).status).toBe(404);
      }
      expect((await store.forRun(stranger, threadId)).model).toBe(
        "gpt-6.1-terra",
      );
      expect(await store.read(owner, channelId)).toEqual({
        model: "gpt-4o",
        effort: null,
      });
    },
  );
});

/*
 * The two ways a deployment decides what people may pick, through the routes the browser calls:
 * `GET /api/models` for the picker and `PUT /api/channels/:id/model` for a pick.
 */
describe("who decides which models people may pick", () => {
  const signedIn =
    (id: string): MiddlewareHandler<{ Variables: AppVariables }> =>
    async (context, next) => {
      context.set("actor", { id, role: "user" } as AppVariables["actor"]);
      await next();
    };

  function routesFor(userId: string, allowed?: string[]) {
    const model = { provider: "openai" as const, defaultModel: "gpt-5.5" };
    const catalogue = createModelCatalogue({
      model,
      apiKey: async () => "synthetic-key",
      environment: {},
      fetch: (async (url: string | URL | Request) =>
        Response.json(
          String(url) === "https://models.dev/api.json" ? modelsDev : listing,
        )) as typeof fetch,
      ...(allowed
        ? { allowlist: () => ({ enabled: false, models: allowed }) }
        : {}),
    });
    const choices = createModelChoices({ database, model, catalogue });
    return {
      models: createModelRoutes(catalogue, signedIn(userId)),
      picks: createModelChoiceRoutes(choices, signedIn(userId)),
    };
  }

  const pick = (
    picks: ReturnType<typeof routesFor>["picks"],
    channelId: string,
    body: unknown,
  ) =>
    picks.request(`/${channelId}/model`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("one person on their own machine is offered every model, and may pick any", async () => {
    const userId = await person();
    const { channelId } = await conversation(userId);
    const routes = routesFor(userId);
    const offered = (await (await routes.models.request("/")).json()) as {
      exposure: string;
      choosable: boolean;
      models: { id: string }[];
    };
    expect(offered.exposure).toBe("all");
    expect(offered.choosable).toBe(true);
    expect(offered.models.map((model) => model.id)).toContain("gpt-6-astra");
    const saved = await pick(routes.picks, channelId, {
      model: "gpt-6-astra",
      effort: "max",
    });
    expect(saved.status).toBe(200);
  });

  test("a team gets the default only until an admin allows a model, then picks among those", async () => {
    const userId = await person();
    const { channelId, threadId } = await conversation(userId);

    const none = routesFor(userId, []);
    const before = (await (await none.models.request("/")).json()) as {
      exposure: string;
      choosable: boolean;
      models: { id: string }[];
    };
    expect(before.exposure).toBe("allowed");
    expect(before.choosable).toBe(false);
    expect(before.models.map((model) => model.id)).toEqual(["gpt-6.1-terra"]);
    // Nothing allowed, so nothing but the default can be picked.
    expect(
      (await pick(none.picks, channelId, { model: "gpt-6-sol", effort: null }))
        .status,
    ).toBe(400);

    const some = routesFor(userId, ["openai/gpt-6-sol", "openai/gpt-6-astra"]);
    const after = (await (await some.models.request("/")).json()) as {
      choosable: boolean;
      models: { id: string }[];
    };
    expect(after.choosable).toBe(true);
    expect(after.models.map((model) => model.id).sort()).toEqual([
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6.1-terra",
    ]);
    expect(
      (
        await pick(some.picks, channelId, {
          model: "gpt-6-sol",
          effort: "high",
        })
      ).status,
    ).toBe(200);
    // A model an admin did not allow is refused, even though the provider lists it.
    expect(
      (await pick(some.picks, channelId, { model: "gpt-6-luna", effort: null }))
        .status,
    ).toBe(400);

    // The admin withdraws it: the saved pick is kept, and the run takes the default.
    const withdrawn = createModelChoices({
      database,
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      catalogue: createModelCatalogue({
        model: { provider: "openai", defaultModel: "gpt-5.5" },
        apiKey: async () => "synthetic-key",
        environment: {},
        fetch: (async (url: string | URL | Request) =>
          Response.json(
            String(url) === "https://models.dev/api.json" ? modelsDev : listing,
          )) as typeof fetch,
        allowlist: () => ({ enabled: false, models: [] }),
      }),
    });
    expect((await withdrawn.forRun(userId, threadId)).model).toBe(
      "gpt-6.1-terra",
    );
  });
});
