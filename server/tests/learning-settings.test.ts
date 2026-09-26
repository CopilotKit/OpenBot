import { describe, expect, test } from "bun:test";
import {
  createLearningSettingsStore,
  parseLearningSettings,
} from "../src/learning/settings";

describe("learning settings", () => {
  test("starts disabled, and persisted off overrides an environment default", async () => {
    const empty = createLearningSettingsStore();
    expect(await empty.read()).toEqual({
      enabled: false,
      defaultTarget: null,
      agents: {},
    });
    const store = createLearningSettingsStore(undefined, {
      containerId: "support",
    });
    expect((await store.read()).enabled).toBe(true);
    const off = { enabled: false, defaultTarget: null, agents: {} };
    await store.write(off);
    expect(await store.read()).toEqual(off);
  });

  test("keeps mappings and exclusions while paused, and isolates returned data", async () => {
    const store = createLearningSettingsStore();
    await store.write({
      enabled: false,
      defaultTarget: { containerId: "general" },
      agents: { bot: { containerId: "support", revision: "7" }, private: null },
    });
    const settings = await store.read();
    settings.agents.bot = null;
    expect((await store.read()).agents.bot).toEqual({
      containerId: "support",
      revision: "7",
    });
  });

  test("first thread assignment remains stable across mapping edits and competing bots", async () => {
    const store = createLearningSettingsStore();
    expect(
      await store.bindThread({
        userId: "owner",
        threadId: "thread",
        agentId: "bot",
        containerId: "support",
      }),
    ).toBe("support");
    expect(
      await store.bindThread({
        userId: "owner",
        threadId: "thread",
        agentId: "other",
        containerId: "sales",
      }),
    ).toBe("support");
    expect(
      await store.bindThread({
        userId: "owner",
        threadId: "excluded",
        agentId: "bot",
        containerId: null,
      }),
    ).toBeNull();
    expect(
      await store.bindThread({
        userId: "owner",
        threadId: "excluded",
        agentId: "bot",
        containerId: "support",
      }),
    ).toBeNull();
  });

  test("rejects malformed container IDs, revisions, and incomplete settings", () => {
    for (const containerId of [
      "UPPER",
      "a--b",
      "-start",
      "end-",
      "a".repeat(65),
      "a/b",
      "",
    ]) {
      expect(
        parseLearningSettings({
          enabled: true,
          defaultTarget: { containerId },
          agents: {},
        }).ok,
      ).toBe(false);
    }
    expect(
      parseLearningSettings({
        enabled: true,
        defaultTarget: { containerId: "a1-b" },
        agents: { bot: null },
      }).ok,
    ).toBe(true);
    expect(
      parseLearningSettings({ enabled: true, defaultTarget: null }).ok,
    ).toBe(false);
    expect(
      parseLearningSettings({
        enabled: true,
        defaultTarget: { containerId: "ok", revision: " " },
        agents: {},
      }).ok,
    ).toBe(false);
  });
});

test("a different user cannot poison another user's first thread assignment", async () => {
  const store = createLearningSettingsStore();
  expect(
    await store.bindThread({
      userId: "attacker",
      threadId: "same-thread-id",
      agentId: "bot",
      containerId: "unrelated",
    }),
  ).toBe("unrelated");
  expect(
    await store.bindThread({
      userId: "owner",
      threadId: "same-thread-id",
      agentId: "bot",
      containerId: "support",
    }),
  ).toBe("support");
});
