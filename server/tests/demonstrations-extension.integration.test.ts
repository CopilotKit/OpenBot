import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import {
  demonstrationSteps,
  demonstrations,
  demonstrationTrajectories,
} from "../src/db/schema/demonstrations";
import { createDemonstrationRecorder } from "../src/demonstrations/recording";
import { createDemonstrationStore } from "../src/demonstrations/store";
import {
  DemonstrationNotFoundError,
  DemonstrationRefusedError,
} from "../src/demonstrations/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `demonstration-extension-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const sharedBot = `${prefix}-shared`;
const otherBot = `${prefix}-other-bot`;
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
const stepRows = (id: string) =>
  database
    .select()
    .from(demonstrationSteps)
    .where(eq(demonstrationSteps.demonstrationId, id));

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  await database.insert(agents).values(
    [bot, sharedBot, otherBot].map((id) => ({
      id,
      name: id,
      type: "built_in" as const,
      configuration: {},
    })),
  );
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database
    .delete(agents)
    .where(inArray(agents.id, [bot, sharedBot, otherBot]));
  await database.$client.close();
});

test("an extension recording has no time limit", async () => {
  const demo = await recorder.start(owner, bot, "Update the deal", "extension");
  expect(demo.expiresAt).toBeNull();
  expect(demo.maxDurationMs).toBeNull();
  await database
    .update(demonstrations)
    .set({ createdAt: new Date(Date.now() - 2 * 60 * 60_000) })
    .where(eq(demonstrations.id, demo.id));
  const read = await store.get(owner, demo.id);
  expect(read.status).toBe("recording");
  expect(read.reachedTimeLimit).toBe(false);
  await recorder.stop(owner, demo.id);
});
test("an extension recording has no step limit and batches are idempotent", async () => {
  const demo = await recorder.start(owner, bot, "Long task", "extension");
  const steps = Array.from({ length: 450 }, (_, i) => ({
    ...click,
    target: { ...click.target, name: `Step ${i}` },
  }));
  expect(await store.appendBatch(owner, demo.id, 0, steps.slice(0, 200))).toBe(
    200,
  );
  expect(
    await store.appendBatch(owner, demo.id, 200, steps.slice(200, 400)),
  ).toBe(400);
  expect(
    await store.appendBatch(owner, demo.id, 200, steps.slice(200, 400)),
  ).toBe(400);
  expect(
    await store.appendBatch(owner, demo.id, 350, steps.slice(350, 450)),
  ).toBe(450);
  expect((await store.get(owner, demo.id)).actionCount).toBe(450);
  await recorder.stop(owner, demo.id);
  const stopped = await store.get(owner, demo.id);
  expect(
    stopped.actions.map((a) => (a as { target: { name: string } }).target.name),
  ).toEqual(steps.map((s) => s.target.name));
  expect(stopped.actionCount).toBe(450);
});
test("a batch writes only its own rows, and Stop folds them into actions once", async () => {
  const demo = await recorder.start(owner, bot, "Rows", "extension");
  await store.appendBatch(
    owner,
    demo.id,
    0,
    Array.from({ length: 50 }, () => click),
  );
  await store.appendBatch(
    owner,
    demo.id,
    50,
    Array.from({ length: 50 }, () => click),
  );
  expect((await stepRows(demo.id)).length).toBe(100);
  const [row] = await database
    .select()
    .from(demonstrations)
    .where(eq(demonstrations.id, demo.id));
  expect(row?.actions).toEqual([]);
  await recorder.stop(owner, demo.id);
  expect((await stepRows(demo.id)).length).toBe(0);
  expect((await store.get(owner, demo.id)).actions).toHaveLength(100);
});
test("a gap is refused with the count the server holds", async () => {
  const demo = await recorder.start(owner, bot, "Gap", "extension");
  await expect(
    store.appendBatch(owner, demo.id, 5, [click]),
  ).rejects.toMatchObject({ name: "DemonstrationGapError", count: 0 });
  await recorder.stop(owner, demo.id);
});
test("a stopped recording takes no more steps", async () => {
  const demo = await recorder.start(owner, bot, "Stopped", "extension");
  await recorder.stop(owner, demo.id);
  await expect(store.appendBatch(owner, demo.id, 0, [click])).rejects.toThrow(
    DemonstrationRefusedError,
  );
});
test("two people record the same shared Bot from their own browsers at once", async () => {
  const mine = await recorder.start(owner, sharedBot, "Mine", "extension");
  const theirs = await recorder.start(other, sharedBot, "Theirs", "extension");
  expect(theirs.source).toBe("extension");
  await recorder.stop(owner, mine.id);
  await recorder.stop(other, theirs.id);
});
test("a second open recording by the same person for the same Bot names the first", async () => {
  const first = await recorder.start(owner, bot, "First", "extension");
  await expect(
    recorder.start(owner, bot, "Second", "extension"),
  ).rejects.toMatchObject({
    name: "DemonstrationOpenError",
    demonstrationId: first.id,
  });
  expect((await store.openExtension(owner, bot))?.id).toBe(first.id);
  await recorder.stop(owner, first.id);
  expect(await store.openExtension(owner, bot)).toBeNull();
});
test("an extension recording does not hold the cloud browser's slot, nor the other way round", async () => {
  const extension = await recorder.start(owner, bot, "Chrome", "extension");
  const cloud = await recorder.start(owner, bot, "Cloud");
  expect(cloud.source).toBe("computer");
  await recorder.stop(owner, cloud.id);
  await recorder.stop(owner, extension.id);
});
test("stopping a stopped extension recording returns it unchanged", async () => {
  const demo = await recorder.start(owner, bot, "S", "extension");
  await store.appendBatch(owner, demo.id, 0, [click]);
  const first = await recorder.stop(owner, demo.id);
  const again = await recorder.stop(owner, demo.id);
  expect(again).toEqual(first);
});
test("a cloud-browser recording keeps its ten-minute and 200-step limits", async () => {
  const demo = await recorder.start(owner, bot, "Cloud limits");
  expect(demo.expiresAt).toBeInstanceOf(Date);
  expect(demo.maxDurationMs).toBe(10 * 60 * 1000);
  for (let i = 0; i < 200; i++)
    await store.append(owner, demo.id, {
      ...click,
      target: { ...click.target, name: `Step ${i}` },
    });
  await expect(store.append(owner, demo.id, click)).rejects.toThrow(
    DemonstrationRefusedError,
  );
  expect((await store.get(owner, demo.id)).status).toBe("stopped");
  const next = await recorder.start(owner, bot, "Cloud expiry");
  await database
    .update(demonstrations)
    .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
    .where(eq(demonstrations.id, next.id));
  const expired = await store.get(owner, next.id);
  expect([expired.status, expired.reachedTimeLimit]).toEqual(["stopped", true]);
});
test("with an extension and a cloud recording open for one person and Bot, the live view only ever finds the cloud one", async () => {
  const extension = await recorder.start(owner, bot, "In Chrome", "extension");
  expect(await store.active(owner, bot)).toBeNull();
  const cloud = await recorder.start(owner, bot, "In the Bot's browser");
  expect((await store.active(owner, bot))?.id).toBe(cloud.id);
  await store.appendBatch(
    owner,
    extension.id,
    0,
    Array.from({ length: 199 }, () => click),
  );
  await expect(store.append(owner, extension.id, click)).rejects.toThrow(
    DemonstrationRefusedError,
  );
  const after = await store.get(owner, extension.id);
  expect([after.status, after.actionCount, after.actions.length]).toEqual([
    "recording",
    199,
    0,
  ]);
  await recorder.stop(owner, cloud.id);
  await recorder.stop(owner, extension.id);
});
test("a rollover can register while the stopped recording still has an open trajectory, and not after", async () => {
  const demo = await recorder.start(owner, bot, "Roll", "extension");
  const first = randomUUID();
  await store.registerTrajectory(owner, demo.id, first);
  await recorder.stop(owner, demo.id);
  const second = randomUUID();
  await store.registerTrajectory(owner, demo.id, second);
  await store.closeTrajectory(owner, demo.id, first);
  await store.closeTrajectory(owner, demo.id, second);
  await expect(
    store.registerTrajectory(owner, demo.id, randomUUID()),
  ).rejects.toThrow(DemonstrationRefusedError);
});
test("presentExtension carries the newest trajectory's learning state", async () => {
  const demo = await recorder.start(owner, bot, "Learning", "extension");
  expect((await store.presentExtension(owner, demo.id)).learning).toBeNull();
  const t1 = randomUUID();
  const t2 = randomUUID();
  await store.registerTrajectory(owner, demo.id, t1);
  await store.setTrajectoryLearning(t1, {
    state: "assigned",
    containerId: "openbot",
  });
  expect((await store.presentExtension(owner, demo.id)).learning).toEqual({
    state: "assigned",
    containerId: "openbot",
  });
  await store.registerTrajectory(owner, demo.id, t2);
  await store.setTrajectoryLearning(t2, {
    state: "unjoined",
    containerId: "openbot",
  });
  const present = await store.presentExtension(owner, demo.id);
  expect(present.learning).toEqual({
    state: "unjoined",
    containerId: "openbot",
  });
  expect("actions" in present).toBe(false);
  await recorder.stop(owner, demo.id);
});
test("trajectories belong to one recording and one person, and close once", async () => {
  const demo = await recorder.start(owner, bot, "T", "extension");
  const trajectoryId = randomUUID();
  await store.registerTrajectory(owner, demo.id, trajectoryId);
  expect(await store.trajectoryOwner(owner, trajectoryId)).toMatchObject({
    demonstrationId: demo.id,
    botId: bot,
    status: "recording",
    source: "extension",
    closedAt: null,
  });
  expect(await store.trajectoryOwner(other, trajectoryId)).toBeNull();
  await expect(
    store.registerTrajectory(other, demo.id, randomUUID()),
  ).rejects.toThrow(DemonstrationNotFoundError);
  await recorder.stop(owner, demo.id);
  expect(
    (await store.trajectoryOwner(owner, trajectoryId))?.closedAt,
  ).toBeNull();
  await store.closeTrajectory(owner, demo.id, trajectoryId);
  const closed = (await store.trajectoryOwner(owner, trajectoryId))?.closedAt;
  await store.closeTrajectory(owner, demo.id, trajectoryId);
  expect(closed).toBeInstanceOf(Date);
  expect((await store.trajectoryOwner(owner, trajectoryId))?.closedAt).toEqual(
    closed ?? undefined,
  );
});
test("a trajectory id already bound to another recording is refused", async () => {
  const a = await recorder.start(owner, bot, "A", "extension");
  const b = await recorder.start(owner, otherBot, "B", "extension");
  const trajectoryId = randomUUID();
  await store.registerTrajectory(owner, a.id, trajectoryId);
  await expect(
    store.registerTrajectory(owner, b.id, trajectoryId),
  ).rejects.toThrow(DemonstrationRefusedError);
  expect(
    (await store.trajectoryOwner(owner, trajectoryId))?.demonstrationId,
  ).toBe(a.id);
  await recorder.stop(owner, a.id);
  await recorder.stop(owner, b.id);
});
test("removeExtension deletes an extension recording and refuses a cloud-browser one", async () => {
  const cloud = await recorder.start(owner, bot, "Cloud");
  await expect(store.removeExtension(owner, cloud.id)).rejects.toThrow(
    DemonstrationRefusedError,
  );
  expect((await store.get(owner, cloud.id)).id).toBe(cloud.id);
  await recorder.stop(owner, cloud.id);
  const extension = await recorder.start(owner, bot, "Chrome", "extension");
  await store.removeExtension(owner, extension.id);
  await expect(store.get(owner, extension.id)).rejects.toThrow(
    DemonstrationNotFoundError,
  );
  await expect(store.removeExtension(owner, extension.id)).rejects.toThrow(
    DemonstrationNotFoundError,
  );
});
test("a later unjoined, unverified or learning-off pass never downgrades an assigned trajectory; missing does", async () => {
  const demo = await recorder.start(owner, bot, "L", "extension");
  const t = randomUUID();
  await store.registerTrajectory(owner, demo.id, t);
  await store.setTrajectoryLearning(t, {
    state: "assigned",
    containerId: "openbot",
  });
  for (const state of ["unjoined", "unverified", "learning-off"] as const) {
    await store.setTrajectoryLearning(t, { state, containerId: "openbot" });
    expect((await store.presentExtension(owner, demo.id)).learning).toEqual({
      state: "assigned",
      containerId: "openbot",
    });
  }
  await store.setTrajectoryLearning(t, {
    state: "missing",
    containerId: "openbot",
  });
  expect((await store.presentExtension(owner, demo.id)).learning?.state).toBe(
    "missing",
  );
  await recorder.stop(owner, demo.id);
});
test("a trajectory records the Learning space its last pass found", async () => {
  const demo = await recorder.start(owner, bot, "Found", "extension");
  const t = randomUUID();
  await store.registerTrajectory(owner, demo.id, t);
  await store.setTrajectoryLearning(t, {
    state: "missing",
    containerId: "gone",
  });
  const [row] = await database
    .select()
    .from(demonstrationTrajectories)
    .where(eq(demonstrationTrajectories.trajectoryId, t));
  expect([row?.learningState, row?.learningContainerId]).toEqual([
    "missing",
    "gone",
  ]);
  await recorder.stop(owner, demo.id);
});
