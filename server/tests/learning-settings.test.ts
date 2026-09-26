import { describe, expect, test } from "bun:test";
import {
  createLearningSettingsStore,
  parseLearningSettings,
} from "../src/learning/settings";

describe("learning settings", () => {
  test("starts enabled without inventing a default container", async () => {
    const empty = createLearningSettingsStore();
    expect(await empty.read()).toEqual({
      enabled: true,
      defaultTarget: null,
      agents: {},
    });
  });

  test("preserves a configured default target and revision", async () => {
    const configured = {
      containerId: "support",
      revision: "7",
    };
    const store = createLearningSettingsStore(undefined, configured);
    expect(await store.read()).toEqual({
      enabled: true,
      defaultTarget: configured,
      agents: {},
    });
  });

  test.each([undefined, { containerId: "support" }])(
    "saved off overrides the default target %j",
    async (configured) => {
      const store = createLearningSettingsStore(undefined, configured);
      const off = { enabled: false, defaultTarget: null, agents: {} };
      await store.write(off);
      expect(await store.read()).toEqual(off);
    },
  );

  test.each([
    [true, null],
    [false, null],
    [false, { containerId: "general" }],
  ] as const)(
    "keeps mappings and exclusions when enabled=%j and defaultTarget=%j",
    async (enabled, defaultTarget) => {
      const store = createLearningSettingsStore();
      const saved = {
        enabled,
        defaultTarget,
        agents: {
          bot: { containerId: "support", revision: "7" },
          private: null,
        },
      };
      await store.write(saved);
      const settings = await store.read();
      settings.agents.bot = null;
      expect(await store.read()).toEqual(saved);
    },
  );

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
