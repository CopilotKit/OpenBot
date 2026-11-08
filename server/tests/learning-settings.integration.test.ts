import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  learningSettings,
  learningThreadBindings,
} from "../src/db/schema/learning";
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
      autoApprove: true,
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
});
