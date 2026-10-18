import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import {
  demonstrationMedia,
  demonstrations,
  demonstrationTrajectories,
} from "../src/db/schema/demonstrations";
import { createDemonstrationRoutes } from "../src/demonstrations/routes";
import { createDemonstrationStore } from "../src/demonstrations/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `demo-list-${randomUUID()}`;
const owner = `${prefix}-owner`;
const bot = `${prefix}-bot`;
const pagedBot = `${prefix}-paged`;
const store = createDemonstrationStore(database);
const click = {
  kind: "click",
  url: "https://example.test/invoices",
  target: { role: "button", name: "Search", sensitive: false },
};
const routes = createDemonstrationRoutes(
  store,
  {} as never,
  async (context, next) => {
    context.set("actor", {
      id: owner,
      email: `${owner}@example.test`,
      role: "member",
    } as never);
    await next();
  },
);
type Listed = {
  demonstrations: Record<string, unknown>[];
  nextBefore: string | null;
};
async function listed(botId: string, before?: string): Promise<Listed> {
  const query = new URLSearchParams({ botId });
  if (before) query.set("before", before);
  const response = await routes.request(`/?${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Listed;
}

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  for (const id of [bot, pagedBot]) {
    await database.insert(agents).values({
      id,
      name: id,
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: id,
      ownerUserId: owner,
      title: id,
      roleDescription: "Assist",
      avatarSeed: id,
      visibility: "private",
    });
  }
});
afterAll(async () => {
  await database.delete(users).where(eq(users.id, owner));
  await database.delete(agents).where(inArray(agents.id, [bot, pagedBot]));
  await database.$client.close();
});

test("rows carry actionCount and no actions, and GET /:id still holds the actions", async () => {
  const cloud = `${prefix}-cloud`;
  await database.insert(demonstrations).values({
    id: cloud,
    ownerUserId: owner,
    botId: bot,
    title: "Cloud",
    status: "stopped",
    actions: [click, click, click] as never,
  });
  const body = await listed(bot);
  const row = body.demonstrations.find((item) => item.id === cloud);
  expect(row?.actionCount).toBe(3);
  expect(row).not.toHaveProperty("actions");
  expect(row?.source).toBe("computer");
  expect(typeof row?.expiresAt).toBe("string");
  expect(row?.learningState).toBeNull();
  expect(row?.media).toEqual([]);
  const full = await routes.request(`/${cloud}`);
  const { demonstration } = (await full.json()) as {
    demonstration: { actions: unknown[] };
  };
  expect(demonstration.actions).toHaveLength(3);
});

test("an extension recording counts its steps from stepCount until Stop folds them in", async () => {
  const recording = await store.start(owner, bot, "In Chrome", "extension");
  await store.appendBatch(owner, recording.id, 0, [click, click]);
  const mid = (await listed(bot)).demonstrations.find(
    (item) => item.id === recording.id,
  );
  expect(mid?.actionCount).toBe(2);
  expect(mid?.expiresAt).toBeNull();
  expect(mid?.maxDurationMs).toBeNull();
  expect(mid?.reachedTimeLimit).toBe(false);
  await store.stop(owner, recording.id);
  const done = (await listed(bot)).demonstrations.find(
    (item) => item.id === recording.id,
  );
  expect(done?.actionCount).toBe(2);
  expect(done).not.toHaveProperty("actions");
});

test("learningState comes from the newest trajectory and media lists only completed media", async () => {
  const id = `${prefix}-extras`;
  await database.insert(demonstrations).values({
    id,
    ownerUserId: owner,
    botId: bot,
    title: "Extras",
    status: "stopped",
    source: "extension",
  });
  await database.insert(demonstrationTrajectories).values([
    {
      trajectoryId: randomUUID(),
      demonstrationId: id,
      ownerUserId: owner,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      learningState: "missing",
    },
    {
      trajectoryId: randomUUID(),
      demonstrationId: id,
      ownerUserId: owner,
      createdAt: new Date("2026-01-02T00:00:00Z"),
      learningState: "assigned",
    },
  ]);
  const done = randomUUID();
  await database.insert(demonstrationMedia).values([
    {
      id: done,
      demonstrationId: id,
      ownerUserId: owner,
      kind: "screen",
      mimeType: "video/webm",
      completedAt: new Date(),
    },
    {
      demonstrationId: id,
      ownerUserId: owner,
      kind: "audio",
      mimeType: "audio/webm",
    },
  ]);
  const row = (await listed(bot)).demonstrations.find((item) => item.id === id);
  expect(row?.learningState).toBe("assigned");
  expect(row?.media).toEqual([{ id: done, kind: "screen" }]);
});

test("pages newest first, 30 at a time, with nextBefore", async () => {
  const start = Date.parse("2026-02-01T00:00:00Z");
  await database.insert(demonstrations).values(
    Array.from({ length: 35 }, (_, index) => ({
      id: `${prefix}-p${index}`,
      ownerUserId: owner,
      botId: pagedBot,
      title: `Row ${index}`,
      status: "stopped" as const,
      createdAt: new Date(start + index * 60_000),
    })),
  );
  const first = await listed(pagedBot);
  expect(first.demonstrations).toHaveLength(30);
  expect(first.demonstrations[0]?.id).toBe(`${prefix}-p34`);
  expect(first.demonstrations[29]?.id).toBe(`${prefix}-p5`);
  expect(first.nextBefore).toBe(new Date(start + 5 * 60_000).toISOString());
  if (!first.nextBefore) throw new Error("Expected nextBefore.");
  const second = await listed(pagedBot, first.nextBefore);
  expect(second.demonstrations.map((item) => item.id)).toEqual([
    `${prefix}-p4`,
    `${prefix}-p3`,
    `${prefix}-p2`,
    `${prefix}-p1`,
    `${prefix}-p0`,
  ]);
  expect(second.nextBefore).toBeNull();
});

test("a before that is not a time is refused", async () => {
  const response = await routes.request(
    `/?botId=${encodeURIComponent(bot)}&before=yesterday`,
  );
  expect(response.status).toBe(400);
});
