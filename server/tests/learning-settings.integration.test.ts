import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  learningSettings,
  learningThreadBindings,
} from "../src/db/schema/learning";
import { currentEdition, setEdition } from "../src/edition";
import { createLearningSettingsStore } from "../src/learning/settings";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const threads: string[] = [];
afterAll(async () => {
  if (threads.length)
    await database
      .delete(learningThreadBindings)
      .where(inArray(learningThreadBindings.threadId, threads));
  await database
    .delete(learningSettings)
    .where(eq(learningSettings.id, "current"));
  await database.$client.close();
});

describe("durable Learning settings", () => {
  test("a fresh database enables learning without a default container", async () => {
    const store = createLearningSettingsStore(database);
    expect(await store.read()).toEqual({
      enabled: true,
      defaultTarget: null,
      agents: {},
    });
  });

  test.each([
    [false, null],
    [true, null],
    [false, { containerId: "saved-default", revision: "saved-revision" }],
  ] as const)(
    "saved enabled=%j and target=%j override defaults across independent stores and restart",
    async (enabled, defaultTarget) => {
      const first = createLearningSettingsStore(database, {
        containerId: "environment-default",
      });
      const second = createLearningSettingsStore(database, {
        containerId: "other-environment",
      });
      const settings = {
        enabled,
        defaultTarget,
        agents: {
          bot: { containerId: "support", revision: "7" },
          excluded: null,
        },
      };
      await first.write(settings);
      expect(await second.read()).toEqual(settings);
      const restartedDatabase = createDatabase(testDatabaseUrl(), TEST_POOL);
      try {
        const restarted = createLearningSettingsStore(restartedDatabase, {
          containerId: "restart-default",
        });
        expect(await restarted.read()).toEqual(settings);
      } finally {
        await restartedDatabase.$client.close();
      }
    },
  );

  test("concurrent servers agree on one first assignment including exclusions", async () => {
    const first = createLearningSettingsStore(database);
    const second = createLearningSettingsStore(database);
    const threadId = `learning-${randomUUID()}`;
    threads.push(threadId);
    const values = await Promise.all([
      first.bindThread({
        userId: "owner",
        threadId,
        agentId: "one",
        containerId: null,
      }),
      second.bindThread({
        userId: "owner",
        threadId,
        agentId: "two",
        containerId: "support",
      }),
    ]);
    expect(values[0]).toBe(values[1]);
    const restarted = createLearningSettingsStore(database);
    expect(
      await restarted.bindThread({
        userId: "owner",
        threadId,
        agentId: "three",
        containerId: "changed",
      }),
    ).toBe(values[0]);
    expect(
      await database
        .select()
        .from(learningThreadBindings)
        .where(eq(learningThreadBindings.threadId, threadId)),
    ).toHaveLength(1);
  });
  test("automatic assignment writes only where nothing was ever saved, and once across replicas", async () => {
    await database
      .delete(learningSettings)
      .where(eq(learningSettings.id, "current"));
    const replicas = [0, 1, 2, 3].map(() =>
      createLearningSettingsStore(database),
    );
    expect(await replicas[0]?.saved()).toBe(false);
    const won = await Promise.all(
      replicas.map((store, index) =>
        store.adoptDefault({ containerId: `openbot-${index}` }),
      ),
    );
    expect(won.filter(Boolean)).toHaveLength(1);
    const winner = won.indexOf(true);
    const assigned = {
      enabled: true,
      defaultTarget: { containerId: `openbot-${winner}` },
      agents: {},
    };
    for (const store of replicas) {
      expect(await store.saved()).toBe(true);
      expect(await store.read()).toEqual(assigned);
    }

    // A saved Admin choice, including off, is never replaced.
    const off = { enabled: false, defaultTarget: null, agents: {} };
    await replicas[0]?.write(off);
    expect(await replicas[1]?.adoptDefault({ containerId: "openbot" })).toBe(
      false,
    );
    expect(await replicas[2]?.read()).toEqual(off);
    await database
      .delete(learningSettings)
      .where(eq(learningSettings.id, "current"));
  });

  test("two users independently bind the same supplied thread ID", async () => {
    const store = createLearningSettingsStore(database);
    const threadId = `learning-${randomUUID()}`;
    threads.push(threadId);
    expect(
      await store.bindThread({
        userId: "attacker",
        threadId,
        agentId: "bot",
        containerId: "unrelated",
      }),
    ).toBe("unrelated");
    expect(
      await store.bindThread({
        userId: "owner",
        threadId,
        agentId: "bot",
        containerId: "support",
      }),
    ).toBe("support");
    expect(
      await database
        .select()
        .from(learningThreadBindings)
        .where(eq(learningThreadBindings.threadId, threadId)),
    ).toHaveLength(2);
  });
});

describe("automatic approval is saved on its own", () => {
  const clear = () =>
    database.delete(learningSettings).where(eq(learningSettings.id, "current"));
  const stores = [
    ["in the database", () => createLearningSettingsStore(database)],
    ["in memory", () => createLearningSettingsStore()],
  ] as const;
  const edition = currentEdition();
  afterEach(async () => {
    setEdition(edition);
    await clear();
  });

  test.each(stores)(
    "personal edition: switching it before the default container is adopted still lets it be adopted (%s)",
    async (_where, create) => {
      await clear();
      setEdition("personal");
      const store = create();
      await store.setAutoApprove(false);
      expect(await store.saved()).toBe(false);
      expect(await store.adoptDefault({ containerId: "openbot" })).toBe(true);
      expect(await store.saved()).toBe(true);
      const settings = await store.read();
      expect(settings.defaultTarget?.containerId).toBe("openbot");
      expect(settings.autoApprove).toBe(false);
      expect(await store.adoptDefault({ containerId: "other" })).toBe(false);
      expect((await store.read()).defaultTarget).toEqual({
        containerId: "openbot",
      });
    },
  );

  test.each(stores)(
    "personal edition: adopting keeps every other saved key (%s)",
    async (_where, create) => {
      await clear();
      setEdition("personal");
      const store = create();
      await store.write({
        enabled: true,
        defaultTarget: null,
        agents: { bot: { containerId: "support" }, excluded: null },
        personalReview: "people",
        autoApprove: true,
      });
      expect(await store.saved()).toBe(false);
      expect(await store.adoptDefault({ containerId: "openbot" })).toBe(true);
      expect(await store.read()).toEqual({
        enabled: true,
        defaultTarget: { containerId: "openbot" },
        agents: { bot: { containerId: "support" }, excluded: null },
        personalReview: "people",
        autoApprove: true,
      });
    },
  );

  test.each([
    [
      "in the database",
      () =>
        createLearningSettingsStore(database, { containerId: "configured" }),
    ],
    [
      "in memory",
      () =>
        createLearningSettingsStore(undefined, { containerId: "configured" }),
    ],
  ] as const)(
    "with nothing saved, a configured default container is kept beside it (%s)",
    async (_where, create) => {
      await clear();
      setEdition("personal");
      const store = create();
      await store.setAutoApprove(true);
      expect(await store.read()).toEqual({
        enabled: true,
        defaultTarget: { containerId: "configured" },
        agents: {},
        autoApprove: true,
      });
    },
  );

  test.each(stores)(
    "a stored off stays off when automatic approval is switched (%s)",
    async (_where, create) => {
      await clear();
      setEdition("team");
      const store = create();
      const off = {
        enabled: false,
        defaultTarget: { containerId: "support" },
        agents: { bot: null },
      };
      await store.write(off);
      setEdition("personal");
      await store.setAutoApprove(true);
      setEdition("team");
      expect(await store.read()).toEqual({ ...off, autoApprove: true });
    },
  );

  test("the database row keeps a stored off when automatic approval is switched", async () => {
    await clear();
    setEdition("team");
    const store = createLearningSettingsStore(database);
    await store.write({ enabled: false, defaultTarget: null, agents: {} });
    setEdition("personal");
    await store.setAutoApprove(true);
    const [row] = await database
      .select({ settings: learningSettings.settings })
      .from(learningSettings)
      .where(eq(learningSettings.id, "current"));
    expect(row?.settings).toEqual({
      enabled: false,
      defaultTarget: null,
      agents: {},
      autoApprove: true,
    });
  });

  test.each(stores)(
    "team edition: a saved null default is an admin's choice and is never adopted over (%s)",
    async (_where, create) => {
      await clear();
      setEdition("team");
      const store = create();
      await store.write({ enabled: true, defaultTarget: null, agents: {} });
      expect(await store.saved()).toBe(true);
      expect(await store.adoptDefault({ containerId: "openbot" })).toBe(false);
      expect((await store.read()).defaultTarget).toBeNull();
    },
  );
});
