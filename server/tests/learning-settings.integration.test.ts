import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  learningSettings,
  learningThreadBindings,
} from "../src/db/schema/learning";
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
