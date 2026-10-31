/**
 * The initiator a check-in's run carries, and the one question every door asks of it.
 *
 * In a module of its own, importing nothing but a type, so the plugin store's dispatcher can ask it
 * too (a check-in may only read, there as well as in `restriction.ts`) without depending on the
 * rest of the check-in code.
 */
import type { AuditInitiator } from "@openbot/toolkit/initiator";

export const PROACTIVE_INITIATOR_PREFIX = "proactive:";

/**
 * A proactive run's initiator. Recorded as an unattended routine-kind run, so every policy written
 * for unattended work applies to it too, with an id that names it as proactive.
 */
export function proactiveInitiator(runId: string): AuditInitiator {
  return { kind: "routine", id: `${PROACTIVE_INITIATOR_PREFIX}${runId}` };
}

export function isProactiveInitiator(
  initiator: AuditInitiator | undefined | null,
): boolean {
  return (
    !!initiator &&
    "id" in initiator &&
    typeof initiator.id === "string" &&
    initiator.id.startsWith(PROACTIVE_INITIATOR_PREFIX)
  );
}

export function proactiveRunIdOf(initiator: AuditInitiator | undefined) {
  return initiator && isProactiveInitiator(initiator) && "id" in initiator
    ? initiator.id.slice(PROACTIVE_INITIATOR_PREFIX.length)
    : null;
}
