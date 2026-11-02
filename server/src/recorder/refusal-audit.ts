import {
  type AuditStore,
  DEPLOYMENT_INITIATOR,
  recordAuditEvent,
} from "../audit";
import type { RecorderRefusalSink } from "./guard";

/** One row per (token digest, reason) in this window: a browser retrying a dead token must not flood the trail. */
const WINDOW_MS = 60_000;

/** Writes recorder.bearer_refused at most once per (token digest prefix, reason) per minute on this replica. */
export function createRecorderRefusalAudit(
  auditStore: AuditStore | undefined,
  options: { now?: () => number } = {},
): RecorderRefusalSink {
  if (!auditStore) return () => {};
  const now = options.now ?? Date.now;
  // Insertion order is time order (a key is only ever added after its old entry is gone), so the expired keys are a prefix.
  const written = new Map<string, number>();

  return (refusal) => {
    const at = now();
    for (const [key, writtenAt] of written) {
      if (at - writtenAt < WINDOW_MS) break;
      written.delete(key);
    }
    const key = `${refusal.tokenDigest ?? "none"}:${refusal.reason}`;
    if (written.has(key)) return;
    written.set(key, at);

    recordAuditEvent(auditStore, {
      eventType: "recorder.bearer_refused",
      targetType: "recorder_token",
      ...(refusal.tokenDigest ? { targetId: refusal.tokenDigest } : {}),
      // A refused token whose person is known is that person's; one nobody can be named for is the deployment refusing a caller.
      ...(refusal.userId
        ? { actorUserId: refusal.userId }
        : { initiator: DEPLOYMENT_INITIATOR }),
      payload: { reason: refusal.reason, path: refusal.path },
    }).catch((error: unknown) => {
      // Never fatal: the refusal is already decided and sent.
      console.error(
        JSON.stringify({
          type: "recorder-refusal-audit-write-failed",
          error: String(error),
        }),
      );
    });
  };
}
