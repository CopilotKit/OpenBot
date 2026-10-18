import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { demonstrations } from "../src/db/schema/demonstrations";
import { createDemonstrationRecorder } from "../src/demonstrations/recording";
import { createDemonstrationStore } from "../src/demonstrations/store";
import { createRecorderDemonstrationRoutes } from "../src/recorder/demonstration-routes";
import type { RecorderVariables } from "../src/recorder/variables";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `recorder-demo-routes-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const store = createDemonstrationStore(database);
const recorder = createDemonstrationRecorder({
  store,
  ownsBot: async () => true,
  ownsSkill: async () => true,
});
const click = {
  kind: "click",
  url: "https://example.test/invoices",
  target: { role: "button", name: "Search", sensitive: false },
} as const;
type Parsed = {
  demonstration: { id: string; status: string };
  error: string;
};
const EXTENSION_DEMONSTRATION_KEYS = [
  "actionCount",
  "botId",
  "id",
  "learning",
  "source",
  "status",
  "title",
];

function appFor(actor: string) {
  const app = new Hono<{ Variables: RecorderVariables }>();
  app.use("*", async (context, next) => {
    context.set("actor", { id: actor, role: "user" } as never);
    await next();
  });
  app.route("/", createRecorderDemonstrationRoutes({ store, recorder }));
  return app;
}
const app = appFor(owner);
const json = (body: unknown, init: RequestInit = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
  ...init,
});
async function start(title = "Update the deal", botId = bot) {
  const response = await app.request("/", json({ botId, title }));
  return {
    response,
    body: (await response.json()) as Parsed,
  };
}

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  await database.insert(agents).values({
    id: bot,
    name: bot,
    type: "built_in" as const,
    configuration: {},
  });
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.delete(agents).where(inArray(agents.id, [bot]));
  await database.$client.close();
});

afterEach(async () => {
  await database
    .delete(demonstrations)
    .where(inArray(demonstrations.ownerUserId, [owner, other]));
});

describe("the extension's demonstration routes", () => {
  test("a start answers 201 with exactly the ExtensionDemonstration shape", async () => {
    const { response, body } = await start();
    expect(response.status).toBe(201);
    expect(Object.keys(body.demonstration).sort()).toEqual(
      EXTENSION_DEMONSTRATION_KEYS,
    );
    expect(body.demonstration).toMatchObject({
      source: "extension",
      status: "recording",
      actionCount: 0,
      learning: null,
    });
    await app.request(`/${body.demonstration.id}`, { method: "DELETE" });
  });

  test("a second start for the same Bot names the open recording, and /open returns it", async () => {
    const first = (await start("First")).body.demonstration;
    const second = await start("Second");
    expect(second.response.status).toBe(409);
    expect(second.body).toMatchObject({
      code: "OPEN_RECORDING",
      demonstrationId: first.id,
    });
    expect(typeof second.body.error).toBe("string");
    const open = await app.request(`/open?botId=${encodeURIComponent(bot)}`);
    expect(open.status).toBe(200);
    expect(((await open.json()) as Parsed).demonstration.id).toBe(first.id);
    const none = await appFor(other).request(
      `/open?botId=${encodeURIComponent(bot)}`,
    );
    expect(await none.json()).toEqual({ demonstration: null });
    await app.request(`/${first.id}`, { method: "DELETE" });
  });

  test("a batch of 256 KiB is accepted and a gap answers 409 with the count", async () => {
    const id = (await start()).body.demonstration.id;
    const long = (index: number) => ({
      ...click,
      url: `https://example.test/${index}/${"x".repeat(1100)}`,
    });
    const actions = Array.from({ length: 200 }, (_, i) => long(i));
    const payload = JSON.stringify({ fromIndex: 0, actions });
    expect(payload.length).toBeGreaterThan(200 * 1024);
    expect(payload.length).toBeLessThan(256 * 1024);
    const accepted = await app.request(`/${id}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ count: 200 });
    const gap = await app.request(
      `/${id}/actions`,
      json({ fromIndex: 210, actions: [click] }),
    );
    expect(gap.status).toBe(409);
    expect(await gap.json()).toMatchObject({ count: 200 });
    const tooBig = await app.request(`/${id}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fromIndex: 200,
        actions: [click],
        padding: "y".repeat(300 * 1024),
      }),
    });
    expect(tooBig.status).toBe(413);
    const bad = await app.request(
      `/${id}/actions`,
      json({ fromIndex: -1, actions: [click] }),
    );
    expect(bad.status).toBe(400);
    await app.request(`/${id}`, { method: "DELETE" });
  });

  test("text/plain on any JSON route is refused with 415", async () => {
    const id = (await start()).body.demonstration.id;
    for (const path of ["/", `/${id}/actions`, `/${id}/trajectories`]) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      });
      expect(response.status).toBe(415);
    }
    await app.request(`/${id}`, { method: "DELETE" });
  });

  test("a JSON body over 2 KiB is refused with 413", async () => {
    const response = await app.request(
      "/",
      json({ botId: bot, title: "t".repeat(4096) }),
    );
    expect(response.status).toBe(413);
  });

  test("trajectories register and close with 204, close answers 404 for an unknown one, and stop answers 200 twice", async () => {
    const id = (await start()).body.demonstration.id;
    const trajectoryId = randomUUID();
    const registered = await app.request(
      `/${id}/trajectories`,
      json({ trajectoryId }),
    );
    expect(registered.status).toBe(204);
    expect(
      (await app.request(`/${id}/trajectories`, json({ trajectoryId: "no" })))
        .status,
    ).toBe(400);
    const unknown = await app.request(
      `/${id}/trajectories/${randomUUID()}/close`,
      { method: "POST" },
    );
    expect(unknown.status).toBe(404);
    expect(typeof ((await unknown.json()) as Parsed).error).toBe("string");
    const notUuid = await app.request(`/${id}/trajectories/not-a-uuid/close`, {
      method: "POST",
    });
    expect(notUuid.status).toBe(404);
    expect(typeof ((await notUuid.json()) as Parsed).error).toBe("string");
    expect(
      (
        await appFor(other).request(
          `/${id}/trajectories/${trajectoryId}/close`,
          {
            method: "POST",
          },
        )
      ).status,
    ).toBe(404);
    const stop = await app.request(`/${id}/stop`, { method: "POST" });
    expect(stop.status).toBe(200);
    expect(((await stop.json()) as Parsed).demonstration.status).toBe(
      "stopped",
    );
    const closed = await app.request(
      `/${id}/trajectories/${trajectoryId}/close`,
      { method: "POST" },
    );
    expect(closed.status).toBe(204);
    const again = await app.request(`/${id}/stop`, { method: "POST" });
    expect(again.status).toBe(200);
    expect(
      Object.keys(((await again.json()) as Parsed).demonstration).sort(),
    ).toEqual(EXTENSION_DEMONSTRATION_KEYS);
    await app.request(`/${id}`, { method: "DELETE" });
  });

  test("DELETE answers 204 for an extension recording and 400 for a cloud-browser one", async () => {
    const id = (await start()).body.demonstration.id;
    expect((await app.request(`/${id}`, { method: "DELETE" })).status).toBe(
      204,
    );
    const cloud = await recorder.start(owner, bot, "In the Bot's browser");
    expect(
      (await app.request(`/${cloud.id}`, { method: "DELETE" })).status,
    ).toBe(400);
    await store.remove(owner, cloud.id);
  });

  test("an unknown id answers 404, and another person's recording is not found", async () => {
    const missing = randomUUID();
    expect(
      (await app.request(`/${missing}/stop`, { method: "POST" })).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `/${missing}/actions`,
          json({ fromIndex: 0, actions: [click] }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await app.request(`/${missing}`, { method: "DELETE" })).status,
    ).toBe(404);
    const id = (await start()).body.demonstration.id;
    expect(
      (await appFor(other).request(`/${id}/stop`, { method: "POST" })).status,
    ).toBe(404);
    await app.request(`/${id}`, { method: "DELETE" });
  });
});
