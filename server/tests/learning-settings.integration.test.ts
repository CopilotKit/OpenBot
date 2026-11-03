import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type { LearningSettings } from "@openbot/shared/learning";
import type { LearningChanges } from "../src/learning/changes";
import { createLearningRuntime } from "../src/learning/runtime";
import { createLearningSettingsStore } from "../src/learning/settings";
import { testIntelligence } from "./support/bots";
import {
  eventually,
  joined,
  removeLearningPeople,
  resetLearningSettings,
  testLearningChanges,
  testLearningIntelligence,
} from "./support/learning";

/*
 * The Learning settings and each thread's container, kept in Intelligence's Learning assignments, read and written the
 * way every OpenBot instance does, against the real test Intelligence and its realtime gateway. Several stores here are
 * several server instances sharing one Intelligence project.
 */

const intelligence = testLearningIntelligence();
const people: string[] = [];
const person = (name: string) => {
  const id = `${name}-${randomUUID()}`;
  people.push(id);
  return id;
};
const subscriptions: LearningChanges[] = [];
const stores: { stop(): void }[] = [];
/** A server instance's settings store, its copy read and kept fresh as index.ts starts it. */
async function instance(
  options: {
    changes?: boolean;
    refreshIntervalMs?: number;
    configured?: { containerId: string };
  } = {},
) {
  let changes: LearningChanges | undefined;
  if (options.changes) {
    changes = testLearningChanges();
    subscriptions.push(changes);
    await joined(changes);
  }
  const store = createLearningSettingsStore(
    intelligence,
    options.configured,
    options.refreshIntervalMs === undefined
      ? {}
      : { refreshIntervalMs: options.refreshIntervalMs },
  );
  await store.start(changes);
  stores.push(store);
  return store;
}
/** The runtime one instance builds over its store, with a real Intelligence client to ask whether a thread exists. */
function runtimeOver(store: Awaited<ReturnType<typeof instance>>) {
  const { apiUrl, apiKey, gatewayWsUrl } = testIntelligence();
  return createLearningRuntime({
    store,
    client: new CopilotKitIntelligence({ apiUrl, apiKey, wsUrl: gatewayWsUrl }),
  });
}

beforeEach(async () => {
  await resetLearningSettings();
});

afterAll(async () => {
  for (const store of stores) store.stop();
  for (const changes of subscriptions) changes.stop();
  await removeLearningPeople(people);
  await resetLearningSettings();
});

describe("durable Learning settings", () => {
  test("a fresh install enables learning without a default container", async () => {
    const store = createLearningSettingsStore(intelligence);
    expect(await store.read()).toEqual({
      enabled: true,
      defaultTarget: null,
      agents: {},
    });
    expect(await store.saved()).toBe(false);
  });

  test.each([
    [false, null],
    [true, null],
    [false, { containerId: "saved-default", revision: "saved-revision" }],
  ] as const)(
    "saved enabled=%j and target=%j override defaults across independent stores and restart",
    async (enabled, defaultTarget) => {
      const first = createLearningSettingsStore(intelligence, {
        containerId: "environment-default",
      });
      const second = createLearningSettingsStore(intelligence, {
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
      const restarted = createLearningSettingsStore(intelligence, {
        containerId: "restart-default",
      });
      expect(await restarted.read()).toEqual(settings);
      expect(await restarted.saved()).toBe(true);
    },
  );

  test("concurrent servers agree on one first assignment including exclusions", async () => {
    const first = createLearningSettingsStore(intelligence);
    const second = createLearningSettingsStore(intelligence);
    const owner = person("owner");
    const threadId = `learning-${randomUUID()}`;
    const values = await Promise.all([
      first.bindThread({
        userId: owner,
        threadId,
        agentId: "one",
        containerId: null,
      }),
      second.bindThread({
        userId: owner,
        threadId,
        agentId: "two",
        containerId: "support",
      }),
    ]);
    expect(values[0]).toBe(values[1]);
    const restarted = createLearningSettingsStore(intelligence);
    expect(
      await restarted.bindThread({
        userId: owner,
        threadId,
        agentId: "three",
        containerId: "changed",
      }),
    ).toBe(values[0]);
    expect(
      (await intelligence.threadAssignments(owner)).filter(
        (row) => row.threadId === threadId,
      ),
    ).toHaveLength(1);
  });

  test("automatic assignment writes only where nothing was ever saved, and once across replicas", async () => {
    // Replicas as index.ts starts them: each with its copy, kept fresh by the change feed.
    const replicas = await Promise.all(
      [0, 1, 2, 3].map(() => instance({ changes: true })),
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
    // The replica refused reads what is saved; another hears of it from the change feed.
    expect(await replicas[1]?.read()).toEqual(off);
    await eventually(
      async () => !(await replicas[2]?.read())?.enabled,
      10_000,
      "another replica to hear the saved off",
    );
    expect(await replicas[2]?.read()).toEqual(off);
    expect(await createLearningSettingsStore(intelligence).read()).toEqual(off);
  });

  test("two users independently bind the same supplied thread ID", async () => {
    const store = createLearningSettingsStore(intelligence);
    const attacker = person("attacker");
    const owner = person("owner");
    const threadId = `learning-${randomUUID()}`;
    expect(
      await store.bindThread({
        userId: attacker,
        threadId,
        agentId: "bot",
        containerId: "unrelated",
      }),
    ).toBe("unrelated");
    expect(
      await store.bindThread({
        userId: owner,
        threadId,
        agentId: "bot",
        containerId: "support",
      }),
    ).toBe("support");
    expect(
      [
        ...(await intelligence.threadAssignments(attacker)),
        ...(await intelligence.threadAssignments(owner)),
      ].filter((row) => row.threadId === threadId),
    ).toHaveLength(2);
  });
});

describe("Learning settings across server instances", () => {
  const settings = (containerId: string): LearningSettings => ({
    enabled: true,
    defaultTarget: { containerId },
    agents: {},
  });

  test("the instance that saves reads its own change at once", async () => {
    const here = await instance();
    await here.write(settings("saved-here"));
    expect((await here.read()).defaultTarget).toEqual({
      containerId: "saved-here",
    });
  });

  test("a change saved on one instance takes effect on another instance's next run", async () => {
    const here = await instance({ changes: true });
    // A long timer, so only the change feed can bring the change.
    const there = await instance({
      changes: true,
      refreshIntervalMs: 60 * 60_000,
    });
    const elsewhere = runtimeOver(there);
    await here.write(settings("first-default"));
    await eventually(
      async () =>
        (await there.read()).defaultTarget?.containerId === "first-default",
      10_000,
      "the other instance to hear the first save",
    );
    const owner = person("next-run");
    // The other instance's next run joins the new default.
    expect(
      await elsewhere.containerForThread({
        userId: owner,
        threadId: randomUUID(),
        agentId: "bot",
      }),
    ).toBe("first-default");

    // Learning switched off there: the other instance's next run has no learned Skills and binds nothing.
    await here.write({ enabled: false, defaultTarget: null, agents: {} });
    await eventually(
      async () => !(await there.read()).enabled,
      10_000,
      "the other instance to hear Learning switched off",
    );
    expect(await elsewhere.acquire("bot", undefined, owner)).toBeUndefined();
    expect(
      await elsewhere.containerForThread({
        userId: owner,
        threadId: randomUUID(),
        agentId: "bot",
      }),
    ).toBeUndefined();
  });

  test("an instance that has not heard of a change yet decides a new thread from the new settings, never its stale copy", async () => {
    const here = await instance();
    // No change feed and a long timer: this instance keeps the copy it read until something makes it read again.
    const there = await instance({ refreshIntervalMs: 60 * 60_000 });
    await here.write(settings("old-default"));
    await there.refresh();
    expect((await there.read()).defaultTarget?.containerId).toBe("old-default");

    await here.write(settings("new-default"));
    // Still the stale copy.
    expect((await there.read()).defaultTarget?.containerId).toBe("old-default");
    const owner = person("stale");
    const threadId = randomUUID();
    expect(
      await runtimeOver(there).containerForThread({
        userId: owner,
        threadId,
        agentId: "bot",
      }),
    ).toBe("new-default");
    // Intelligence recorded the new decision, made from the version saved last.
    const [assigned] = await intelligence.threadAssignments(owner);
    const current = await intelligence.agentAssignments();
    expect(assigned).toMatchObject({
      threadId,
      learningContainerId: "new-default",
      assignmentsVersion: current.version,
    });
    // And the instance holds the new settings now.
    expect((await there.read()).defaultTarget?.containerId).toBe("new-default");
  });

  test("an announcement missed by an instance is picked up on its timer", async () => {
    const here = await instance();
    const there = await instance({ refreshIntervalMs: 200 });
    await here.write(settings("timer-default"));
    await eventually(
      async () =>
        (await there.read()).defaultTarget?.containerId === "timer-default",
      5_000,
      "the timer to read the change",
    );
  });

  test("a thread's container never moves once bound, and is answered from memory after that", async () => {
    const here = await instance();
    await here.write(settings("kept"));
    const runtime = runtimeOver(here);
    const owner = person("kept");
    const thread = { userId: owner, threadId: randomUUID(), agentId: "bot" };
    expect(await runtime.containerForThread(thread)).toBe("kept");
    await here.write(settings("moved"));
    expect(await runtime.containerForThread(thread)).toBe("kept");
    // Another instance, which never saw it bound, reads the same answer from Intelligence.
    const there = await instance();
    expect(await runtimeOver(there).containerForThread(thread)).toBe("kept");
  });
});
