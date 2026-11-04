import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { LearningSettings } from "@openbot/shared/learning";
import {
  IntelligenceKnowingANewThread,
  type LearningRefusal,
} from "@openbot/toolkit/copilotkit/agents";
import { createLearningRuntime } from "../src/learning/runtime";
import type { LearningSettingsStore } from "../src/learning/settings";
import { testIntelligence } from "./support/bots";

/*
 * FOUND IN THE BROWSER, on the two-organization end to end. One organization's Learning setting named a container its
 * Intelligence project did not have (seeded from an older install), and with Learning off in Intelligence the same
 * happened for any container: every new conversation failed with "Failed to initialize thread", for every person.
 * Learning is something a conversation adds to. Without it the conversation goes on, the Bot runs without its learned
 * Skills, and only the admin is told, on the Learning page.
 *
 * Against the real test Intelligence: whichever of the two refusals it gives (Learning off, or Learning on and no such
 * container), the answer here has to be the same.
 */

const { apiUrl, apiKey, gatewayWsUrl } = testIntelligence();
const refused: LearningRefusal[] = [];
const intelligence = new IntelligenceKnowingANewThread({
  apiUrl,
  apiKey,
  wsUrl: gatewayWsUrl,
  onLearningRefused: (refusal) => refused.push(refusal),
});
const containerId = `no-such-space-${randomUUID().slice(0, 8)}`;
const userId = `learning-refused-${randomUUID()}`;
const threads: string[] = [];

afterAll(async () => {
  for (const threadId of threads)
    await intelligence
      .deleteThread({ threadId, userId, agentId: "bot" })
      .catch(() => {});
});

test("a new conversation naming a container Intelligence will not use starts without it", async () => {
  const threadId = randomUUID();
  threads.push(threadId);
  // What the runtime does to start a run: the thread, then the run's lock on it, both naming the container.
  const { created } = await intelligence.getOrCreateThread({
    threadId,
    userId,
    agentId: "bot",
    learningContainerId: containerId,
  });
  expect(created).toBe(true);
  const runId = randomUUID();
  const lock = await intelligence.ɵacquireThreadLock({
    threadId,
    runId,
    userId,
    agentId: "bot",
    learningContainerId: containerId,
  });
  expect(lock.threadId).toBe(threadId);
  await intelligence.ɵcleanupThreadLock({ threadId, runId });

  expect(refused.length).toBeGreaterThanOrEqual(2);
  for (const refusal of refused) {
    expect(refusal.learningContainerId).toBe(containerId);
    expect(["LEARNING_NOT_ENABLED", "LEARNING_CONTAINER_NOT_FOUND"]).toContain(
      refusal.code,
    );
  }
});

test("a Bot whose container Intelligence will not use runs without learned Skills, and the admin is told why", async () => {
  const settings: LearningSettings = {
    enabled: true,
    defaultTarget: { containerId },
    agents: {},
  };
  const store = {
    read: async () => settings,
    snapshot: async () => ({ settings, version: 0 }),
  } as unknown as LearningSettingsStore;
  const learning = createLearningRuntime({ store, client: intelligence });

  // Before, this read threw and took the run with it.
  expect(await learning.acquire("bot", undefined)).toBeUndefined();
  const problems = await learning.problems();
  expect(problems).toHaveLength(1);
  expect(problems[0]?.containerId).toBe(containerId);
  expect(["missing", "learning_off"]).toContain(problems[0]?.problem ?? "");
});
