import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { proactiveSettings } from "../src/db/schema/proactive";
import { createProactiveEngine } from "../src/proactive/engine";
import { createProactiveRoutes } from "../src/proactive/routes";
import { createProactiveStore } from "../src/proactive/store";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * POST /api/proactive/settings against real Postgres, the real store and the real routes.
 *
 * New routine asks for a new check-in (`?refuseExisting=true`). A check-in the Bot already has on
 * the same thing is refused with 409 and the sentence the screen shows on Name: changing it in place
 * kept it posting in its own conversation and answered 201, so a screen that hadn't read the list
 * yet overwrote it without a word. Accepting a Bot's offer and Turn on check-ins send no flag, and
 * still turn that one back on.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `new-check-in-owner-${suite}`;
const bot = `new-check-in-bot-${suite}`;
const channelA = `new-check-in-a-${suite}`;
const channelB = `new-check-in-b-${suite}`;
const store = createProactiveStore(database);
const engine = createProactiveEngine({
  store,
  queue: createWorkQueue(database),
  owner: `new-check-in-${suite}`,
  runTurn: async () => ({ replyText: "" }),
  resolveScope: async (ownerUserId, channelId, agentId) =>
    ownerUserId === owner && [channelA, channelB].includes(channelId)
      ? { ownerUserId, channelId, agentId, threadId: `${channelId}-thread` }
      : null,
  attention: { deliver: async () => undefined } as never,
  catalogue: { listServers: async () => [] },
  mintThreadId: () => `new-check-in-thread-${randomUUID()}`,
});
const app = new Hono().route(
  "/api/proactive",
  createProactiveRoutes(store, engine, (async (
    context: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    context.set("actor", { id: owner, email: `${owner}@example.test` });
    await next();
  }) as never),
);

const SAME_CHECK_IN =
  "This Bot already checks in on this. Give this one a different name, or change that one on its row.";

function post(body: Record<string, unknown>, query = "") {
  return app.request(`http://t/api/proactive/settings${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: bot, ...body }),
  });
}

const mine = () =>
  database
    .select()
    .from(proactiveSettings)
    .where(eq(proactiveSettings.ownerUserId, owner));

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await database.insert(agents).values({
    id: bot,
    name: "Inbox Bot",
    type: "built_in",
    configuration: {},
  });
});
// Each test starts with no check-ins, whatever the one before it left.
afterEach(async () => {
  await database
    .delete(proactiveSettings)
    .where(eq(proactiveSettings.ownerUserId, owner));
});
afterAll(async () => {
  await database.delete(users).where(eq(users.id, owner));
  await database.delete(agents).where(inArray(agents.id, [bot]));
  await database.$client.close();
});

test("a new check-in on a thing the Bot already watches is refused with 409, and the one it has is left alone", async () => {
  const first = await post(
    { channelId: channelA, subject: "Watch my inbox", intervalMinutes: 60 },
    "?refuseExisting=true",
  );
  expect(first.status).toBe(201);
  const { setting } = (await first.json()) as { setting: { id: string } };

  // The same subject in another case, another conversation and another interval.
  const again = await post(
    {
      channelId: channelB,
      subject: "watch MY inbox",
      focus: "Invoices only",
      intervalMinutes: 1440,
    },
    "?refuseExisting=true",
  );
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ error: SAME_CHECK_IN });

  const rows = await mine();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: setting.id,
    channelId: channelA,
    intervalMinutes: 60,
    focus: "",
  });

  // Another thing is another check-in.
  const other = await post(
    { channelId: channelB, subject: "Supplier invoices" },
    "?refuseExisting=true",
  );
  expect(other.status).toBe(201);
  expect(await mine()).toHaveLength(2);
});

test("without the flag, as an accepted offer and Turn on check-ins send it, the one it has is turned back on", async () => {
  const first = await post({
    channelId: channelA,
    subject: "Launch brief",
    intervalMinutes: 60,
  });
  expect(first.status).toBe(201);
  const { setting } = (await first.json()) as { setting: { id: string } };
  await store.update(owner, setting.id, { enabled: false });

  const accepted = await post({
    channelId: channelA,
    subject: "launch brief",
    intervalMinutes: 240,
  });
  expect(accepted.status).toBe(201);
  expect(
    ((await accepted.json()) as { setting: Record<string, unknown> }).setting,
  ).toMatchObject({ id: setting.id, enabled: true, intervalMinutes: 240 });
  expect(await mine()).toHaveLength(1);

  // A flag other than "true" is no flag.
  const loose = await post(
    { channelId: channelA, subject: "Launch brief", intervalMinutes: 720 },
    "?refuseExisting=false",
  );
  expect(loose.status).toBe(201);
  expect(await mine()).toHaveLength(1);
});
