/**
 * This process's connection to the audit trail in Intelligence: the client that reads it and the
 * drainer that carries the outbox to it.
 *
 * Installed once at boot (index.ts), the way the Bot directory is, so the stores that write and read
 * the trail keep their signatures: `createAuditStore(database)` writes the outbox and wakes the
 * drainer, `createAuditReader(database)` reads Intelligence. A test installs it from
 * `tests/support/audit.ts`.
 */
import type { AuditTrailClient } from "./client";
import type { AuditDrainer } from "./drainer";

export type AuditTrail = {
  client: AuditTrailClient;
  drainer: AuditDrainer;
};

let installed: AuditTrail | undefined;

export function installAuditTrail(trail: AuditTrail): AuditTrail {
  installed = trail;
  return trail;
}

/** The installed trail. Throws, naming the fix, when nothing installed one. */
export function auditTrail(): AuditTrail {
  if (!installed) {
    throw new Error(
      "The audit trail is not connected to Intelligence: installAuditTrail runs at boot (index.ts), and a test calls useTestAuditTrail (tests/support/audit.ts).",
    );
  }
  return installed;
}

/**
 * Send what this deployment has written before reading, so a person sees what they just did.
 *
 * A failure here is said and not thrown: the read that follows asks Intelligence anyway, and answers
 * (or fails) for itself.
 */
export async function flushBeforeRead(trail: AuditTrail): Promise<void> {
  try {
    await trail.drainer.flush();
  } catch (error) {
    console.warn(
      JSON.stringify({
        type: "audit-flush-before-read-failed",
        note: "What was just written may not be in this read yet; it is sent as soon as Intelligence takes it.",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
