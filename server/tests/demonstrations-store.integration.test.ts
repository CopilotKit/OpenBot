import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channelAgents,
  channelMemberships,
  channels,
  users,
} from "../src/db/schema/core";
import { agentProfiles, routines } from "../src/db/schema/coworker";
import { demonstrations } from "../src/db/schema/demonstrations";
import { skills } from "../src/db/schema/plugins";
import { createDemonstrationRecorder } from "../src/demonstrations/recording";
import { createDemonstrationRoutes } from "../src/demonstrations/routes";
import { createDemonstrationStore } from "../src/demonstrations/store";
import {
  DemonstrationNotFoundError,
  DemonstrationRefusedError,
} from "../src/demonstrations/types";
import { createPluginStore } from "../src/plugins/store";
import { createRoutineStore } from "../src/routines/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `demonstration-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const skillSlug = `demo-${randomUUID().slice(0, 8)}`;
const plugins = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 9).toString("base64"),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});
const store = createDemonstrationStore(database);
const routineStore = createRoutineStore(database);
const channelId = `${prefix}-channel`;
const recorder = createDemonstrationRecorder({
  store,
  routines: routineStore,
  ownsBot: async (person, target) =>
    (await plugins.agentOwner(target)) === person,
  ownsSkill: async (person, slug) =>
    (await plugins.skillOwner(slug)) === person,
});
const click = {
  kind: "click",
  url: "https://example.test/invoices",
  target: { role: "button", name: "Search", sensitive: false },
};
beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  await database.insert(agents).values({
    id: bot,
    name: "Demonstration Bot",
    type: "built_in",
    configuration: {},
  });
  await database.insert(agentProfiles).values({
    agentId: bot,
    ownerUserId: owner,
    title: "Demonstration Bot",
    roleDescription: "Assist",
    avatarSeed: bot,
    visibility: "private",
  });
});
afterAll(async () => {
  await database.delete(routines).where(eq(routines.agentId, bot));
  await database.delete(channels).where(eq(channels.id, channelId));
  await database.delete(skills).where(eq(skills.slug, skillSlug));
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.delete(agents).where(eq(agents.id, bot));
  await database.$client.close();
});
test("recording binds owner and Bot and rejects cross-owner capture", async () => {
  await expect(
    recorder.start(other, bot, "Steal workflow"),
  ).rejects.toBeInstanceOf(DemonstrationRefusedError);
  const value = await recorder.start(owner, bot, "Owned workflow");
  await expect(store.get(other, value.id)).rejects.toBeInstanceOf(
    DemonstrationNotFoundError,
  );
  await expect(
    recorder.capture(other, bot, value.id, click),
  ).rejects.toBeInstanceOf(DemonstrationNotFoundError);
  await store.stop(owner, value.id);
});
test("real source identity retains ordered actions and groups typing without values", async () => {
  const value = await recorder.start(owner, bot, "Find invoice");
  await recorder.capture(owner, bot, value.id, click);
  await recorder.capture(owner, bot, value.id, { ...click, kind: "type" });
  await recorder.capture(owner, bot, value.id, { ...click, kind: "type" });
  await recorder.capture(owner, bot, value.id, {
    ...click,
    kind: "key",
    key: "Enter",
  });
  expect(
    (await store.get(owner, value.id)).actions.map((action) => action.kind),
  ).toEqual(["click", "type", "key"]);
  await store.stop(owner, value.id);
  const draft = await store.draft(owner, value.id);
  expect(draft.sourceRecordingId).toBe(value.id);
  expect(draft.instructions).toContain("{{input_1}}");
});
test("stopped recording ignores late successful events instead of changing its draft", async () => {
  const value = await recorder.start(owner, bot, "Completed workflow");
  await recorder.capture(owner, bot, value.id, click);
  await store.stop(owner, value.id);
  await recorder.capture(owner, bot, value.id, {
    ...click,
    kind: "scroll",
    deltaY: 500,
  });
  expect((await store.get(owner, value.id)).actions).toHaveLength(1);
});
test("concurrent starts produce one active recording", async () => {
  const attempts = await Promise.allSettled([
    recorder.start(owner, bot, "One"),
    recorder.start(owner, bot, "Two"),
  ]);
  expect(
    attempts.filter((attempt) => attempt.status === "fulfilled"),
  ).toHaveLength(1);
  const active = await store.active(owner, bot);
  if (!active) throw new Error("Expected active recording.");
  await store.stop(owner, active.id);
});
test("publication links only an actual owned saved skill", async () => {
  const value = await recorder.start(owner, bot, "Reviewed workflow");
  await recorder.capture(owner, bot, value.id, click);
  await store.stop(owner, value.id);
  await store.draft(owner, value.id);
  await expect(
    recorder.markPublished(owner, value.id, "foreign-skill"),
  ).rejects.toBeInstanceOf(DemonstrationRefusedError);
  const draft = await store.draft(owner, value.id);
  await plugins.installSkill({
    ...draft,
    slug: skillSlug,
    ownerUserId: owner,
    by: `${owner}@example.test`,
  });
  await plugins.grant("skill", skillSlug, bot, owner);
  const saved = await recorder.markPublished(owner, value.id, skillSlug);
  expect(saved.status).toBe("published");
  expect(saved.skillSlug).toBe(skillSlug);
  const granted = await plugins.listForAgent(bot);
  expect(
    granted.skills.some(
      (skill) =>
        skill.slug === skillSlug && skill.instructions === draft.instructions,
    ),
  ).toBe(true);
  expect(granted.tools).toHaveLength(0);
});

test("a recording past ten minutes is stopped at its limit and keeps no later step", async () => {
  const value = await recorder.start(owner, bot, "Long workflow");
  expect(value.expiresAt.getTime() - value.createdAt.getTime()).toBe(600_000);
  await recorder.capture(owner, bot, value.id, click);
  await database
    .update(demonstrations)
    .set({ createdAt: new Date(Date.now() - 11 * 60 * 1000) })
    .where(eq(demonstrations.id, value.id));
  // Like any stopped recording, a gesture after the limit is ignored rather than kept.
  await recorder.capture(owner, bot, value.id, { ...click, kind: "scroll" });
  const stopped = await store.get(owner, value.id);
  expect(stopped.status).toBe("stopped");
  expect(stopped.reachedTimeLimit).toBe(true);
  expect(stopped.actions).toHaveLength(1);
  expect(await store.active(owner, bot)).toBeNull();
});
test("reads expire an overdue recording even when no step arrives", async () => {
  const value = await recorder.start(owner, bot, "Idle workflow");
  await database
    .update(demonstrations)
    .set({ createdAt: new Date(Date.now() - 11 * 60 * 1000) })
    .where(eq(demonstrations.id, value.id));
  expect(await store.active(owner, bot)).toBeNull();
  const listed = (await store.list(owner, bot)).find(
    (row) => row.id === value.id,
  );
  expect(listed?.status).toBe("stopped");
  expect(listed?.reachedTimeLimit).toBe(true);
});
test("a published demonstration skill runs on a schedule as the owner's routine", async () => {
  await database
    .insert(channels)
    .values({ id: channelId, name: "Invoices", description: "" });
  await database
    .insert(channelMemberships)
    .values({ channelId, userId: owner });
  await database.insert(channelAgents).values({ channelId, agentId: bot });
  const published = (await store.list(owner, bot)).find(
    (row) => row.status === "published",
  );
  if (!published) throw new Error("Expected the published demonstration.");
  await expect(
    recorder.schedule(other, published.id, { cron: "0 9 * * 1-5" }),
  ).rejects.toBeInstanceOf(DemonstrationNotFoundError);
  await expect(
    recorder.schedule(owner, published.id, { cron: "* * * * *" }),
  ).rejects.toBeInstanceOf(DemonstrationRefusedError);
  const routine = await recorder.schedule(owner, published.id, {
    cron: "0 9 * * 1-5",
    timezone: "Europe/London",
  });
  expect(routine.channelId).toBe(channelId);
  const listed = (await routineStore.listFor(owner)).find(
    (row) => row.id === routine.id,
  );
  expect(listed?.agentId).toBe(bot);
  expect(listed?.enabled).toBe(true);
  expect(listed?.instruction).toContain(`/${skillSlug}`);
  expect(await routineStore.listFor(other)).toHaveLength(0);
});
test("a step racing the limit is refused inside the locked append", async () => {
  const value = await recorder.start(owner, bot, "Racing workflow");
  await database
    .update(demonstrations)
    .set({ createdAt: new Date(Date.now() - 11 * 60 * 1000) })
    .where(eq(demonstrations.id, value.id));
  await expect(store.append(owner, value.id, click)).rejects.toThrow(
    "ten-minute limit",
  );
  const stopped = await store.get(owner, value.id);
  expect(stopped.status).toBe("stopped");
  expect(stopped.reachedTimeLimit).toBe(true);
  expect(stopped.actions).toHaveLength(0);
});
test("the schedule route parses its body over HTTP and answers with the routine and limits", async () => {
  const routes = createDemonstrationRoutes(
    store,
    recorder,
    async (context, next) => {
      context.set("actor", {
        id: owner,
        email: `${owner}@example.test`,
        role: "member",
      } as never);
      await next();
    },
  );
  const published = (await store.list(owner, bot)).find(
    (row) => row.status === "published",
  );
  if (!published) throw new Error("Expected the published demonstration.");
  const listed = await routes.request(`/?botId=${encodeURIComponent(bot)}`);
  const body = (await listed.json()) as {
    demonstrations: { expiresAt: string; maxDurationMs: number }[];
  };
  expect(body.demonstrations[0]?.maxDurationMs).toBe(600_000);
  expect(typeof body.demonstrations[0]?.expiresAt).toBe("string");
  const refused = await routes.request(`/${published.id}/schedule`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cron: "0 9 * * *", agentId: "someone-else" }),
  });
  expect(refused.status).toBe(400);
  const created = await routes.request(`/${published.id}/schedule`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cron: "30 8 * * 1", channelId }),
  });
  expect(created.status).toBe(201);
  const { routine } = (await created.json()) as {
    routine: { agentId: string; channelId: string; nextRunAt: string };
  };
  expect(routine.agentId).toBe(bot);
  expect(routine.channelId).toBe(channelId);
  expect(Date.parse(routine.nextRunAt)).toBeGreaterThan(Date.now());
});
