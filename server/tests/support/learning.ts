// server/tests/support/learning.ts
//
// Learning settings and pointers for the tests, in a real Intelligence.
//
// The Admin Learning settings, each thread's container, each person's space and sharing choice, and whose each Recorder
// trajectory is live in Intelligence's Learning assignments (src/learning/intelligence.ts). A test reads and writes
// them there, through the same client the server uses: a fake that passed while the real one refused would be exactly
// the test that lies.
//
// WHICH INTELLIGENCE. `TEST_INTELLIGENCE_API_URL`, `TEST_INTELLIGENCE_API_KEY` and `TEST_INTELLIGENCE_GATEWAY_WS_URL`
// name it (support/bots.ts): missing, every test that touches these fails here and says so.
import { createProjectChangesClient } from "../../src/intelligence/project-changes";
import {
  createLearningChanges,
  type LearningChanges,
} from "../../src/learning/changes";
import {
  createLearningIntelligence,
  type LearningIntelligence,
} from "../../src/learning/intelligence";
import { removePersonLearning } from "../../src/learning/personal-space";
import { testIntelligence } from "./bots";

let client: LearningIntelligence | undefined;

/** The Learning assignments client for the test Intelligence. Throws, loudly, when it is not set. */
export function testLearningIntelligence(): LearningIntelligence {
  if (client) return client;
  const intelligence = testIntelligence();
  client = createLearningIntelligence({
    apiUrl: intelligence.apiUrl,
    apiKey: intelligence.apiKey,
  });
  return client;
}

/**
 * A `learning_changes` subscription to the test Intelligence's realtime gateway, started, as one server instance holds
 * one. Each call is another instance's. Stop it when done.
 */
export function testLearningChanges(): LearningChanges {
  const intelligence = testIntelligence();
  const changes = createLearningChanges({
    client: createProjectChangesClient({
      apiUrl: intelligence.apiUrl,
      apiKey: intelligence.apiKey,
    }),
    gatewayWsUrl: intelligence.gatewayWsUrl,
  });
  changes.start();
  return changes;
}

/** Waits until `changes` is joined, so an announcement made after this is heard. */
export async function joined(
  changes: LearningChanges,
  timeoutMs = 10_000,
): Promise<void> {
  await eventually(() => changes.subscribed(), timeoutMs, "joined");
}

/** Polls `check` until it is true, failing by name after `timeoutMs`. */
export async function eventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  what = "the condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Forget the project's saved Learning settings, so a test starts from nothing saved. */
export async function resetLearningSettings(): Promise<void> {
  await testLearningIntelligence().purgeAgentAssignments();
}

/** Remove people's Learning records in Intelligence, as test cleanup: their space, sharing choice and threads. */
export async function removeLearningPeople(
  userIds: readonly string[],
): Promise<void> {
  const intelligence = testLearningIntelligence();
  for (const userId of userIds)
    await removePersonLearning(intelligence, userId);
}
