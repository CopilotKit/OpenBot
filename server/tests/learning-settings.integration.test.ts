import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  learningSettings,
  learningThreadBindings,
} from "../src/db/schema/learning";
import { currentEdition, setEdition } from "../src/edition";
import { createLearningRuntime } from "../src/learning/runtime";
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

  /*
   * FOUND ON THE MAC: a build of an unmerged branch saved this row with an "autoApprove" key, and the
   * Desktop was then put back to a main build that does not know it. Main's reader refused the whole
   * row ("Stored learning settings are invalid."), and every chat run failed with "Failed to resolve
   * Learning Container". Builds do go back (an update rolled back), so a key a newer build wrote is
   * dropped and the ones this build knows are kept.
   */
  test("a row a newer build saved, with a key this build does not know, is read for the keys it does", async () => {
    const newer = {
      agents: {},
      enabled: true,
      fromANewerBuild: true,
      defaultTarget: { containerId: "openbot", pinnedBy: "a-newer-build" },
    } as never;
    await database
      .insert(learningSettings)
      .values({ id: "current", settings: newer })
      .onConflictDoUpdate({
        target: learningSettings.id,
        set: { settings: newer },
      });
    expect(await createLearningSettingsStore(database).read()).toEqual({
      enabled: true,
      defaultTarget: { containerId: "openbot" },
      agents: {},
    });
  });

  test("who reviews and automatic approval are read back from a saved row, not dropped as a newer build's keys", async () => {
    // Merging main's forgiving reader into this branch first listed only the keys main knew, so a person's choice to
    // review their own skills, and automatic approval switched off, were dropped every time the row was read.
    const saved = {
      agents: {},
      enabled: true,
      defaultTarget: { containerId: "openbot" },
      personalReview: "people",
      autoApprove: false,
    } as never;
    await database
      .insert(learningSettings)
      .values({ id: "current", settings: saved })
      .onConflictDoUpdate({
        target: learningSettings.id,
        set: { settings: saved },
      });
    expect(await createLearningSettingsStore(database).read()).toEqual({
      enabled: true,
      defaultTarget: { containerId: "openbot" },
      agents: {},
      personalReview: "people",
      autoApprove: false,
    });
  });

  test("a row that cannot be read never fails a chat run: the run goes ahead without Learning", async () => {
    // Not a settings shape at all, as a corrupted row would be: the column's type cannot say it.
    const broken = { enabled: "yes", defaultTarget: 7, agents: [] } as never;
    await database
      .insert(learningSettings)
      .values({ id: "current", settings: broken })
      .onConflictDoUpdate({
        target: learningSettings.id,
        set: { settings: broken },
      });
    const store = createLearningSettingsStore(database);
    // An administrator reading the settings is still told.
    await expect(store.read()).rejects.toThrow(
      "Stored learning settings are invalid.",
    );
    const learning = createLearningRuntime({
      store,
      client: new CopilotKitIntelligence({ apiKey: "synthetic-never-sent" }),
    });
    const threadId = `broken-${randomUUID()}`;
    threads.push(threadId);
    expect(
      await learning.containerForThread({
        userId: "person",
        threadId,
        agentId: "bot",
      }),
    ).toBeUndefined();
    expect(await learning.acquire("bot")).toBeUndefined();
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

  test("a saved default set aside on this Intelligence reads as its stand-in and stays saved through a save of what was read", async () => {
    const store = createLearningSettingsStore(database);
    await store.write({
      enabled: true,
      defaultTarget: { containerId: "hosted-learning" },
      agents: {},
    });
    store.setAside("hosted-learning", { containerId: "openbot" });
    expect((await store.read()).defaultTarget).toEqual({
      containerId: "openbot",
    });
    expect(store.isSetAside("hosted-learning")).toBe(true);

    await store.write({ ...(await store.read()), personalReview: "people" });
    const [row] = await database
      .select({ settings: learningSettings.settings })
      .from(learningSettings)
      .where(eq(learningSettings.id, "current"));
    expect(row?.settings).toMatchObject({
      defaultTarget: { containerId: "hosted-learning" },
      personalReview: "people",
    });
    // Another replica, or this server pointed back at the Intelligence it was chosen on, reads it.
    expect(
      (await createLearningSettingsStore(database).read()).defaultTarget,
    ).toEqual({ containerId: "hosted-learning" });

    // Choosing another container is a new choice, and replaces it.
    await store.write({
      ...(await store.read()),
      defaultTarget: { containerId: "support" },
    });
    expect(await store.savedDefault()).toEqual({ containerId: "support" });
    expect((await store.read()).defaultTarget).toEqual({
      containerId: "support",
    });
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
