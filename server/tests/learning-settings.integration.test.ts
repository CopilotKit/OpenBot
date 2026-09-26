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
  test("saved settings override environment defaults across independent stores", async () => {
    const first = createLearningSettingsStore(database, {
      containerId: "environment-default",
    });
    const second = createLearningSettingsStore(database, {
      containerId: "other-environment",
    });
    const settings = {
      enabled: false,
      defaultTarget: { containerId: "support" },
      agents: { excluded: null },
    };
    await first.write(settings);
    expect(await second.read()).toEqual(settings);
  });

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
