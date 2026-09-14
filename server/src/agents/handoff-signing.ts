import { randomUUID } from "node:crypto";
import { mintRunAssertion, type RunAssertion } from "./callback-token";
import type { HandoffWork } from "./handoff-runner";

/**
 * The signed run identity for a queued handoff delivery.
 *
 * Kept outside index.ts so tests can exercise the same production boundary without booting the
 * server. The queue already carries the original run context; this function is the single place that
 * turns that queued context into the assertion the addressed Bot receives.
 */
export function handoffDeliveryRunAssertion(
  work: HandoffWork,
  runId: string,
): RunAssertion {
  return {
    botId: work.toBotId,
    actorId: work.actorId,
    runId,
    threadId: work.threadId,
    depth: work.depth,
    ...(work.initiator ? { initiator: work.initiator } : {}),
  };
}

export function signHandoffDeliveryRun(
  work: HandoffWork,
  encryptionKey: string,
  runId: string = randomUUID(),
): string {
  return mintRunAssertion(
    handoffDeliveryRunAssertion(work, runId),
    encryptionKey,
  );
}
