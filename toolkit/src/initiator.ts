/**
 * What caused a turn, or a row on the audit trail, where `actorUserId` is only whose authority it
 * borrowed. Re-exported from audit.ts, which is where the rest of the server reads it.
 */
export type AuditInitiator =
  | { kind: "person" }
  | { kind: "deployment" }
  | { kind: "routine"; id: string }
  | { kind: "responsibility"; id: string }
  | { kind: "memory"; id: string }
  | { kind: "handoff"; id: string; origin?: AuditInitiator };

/**
 * Whether nobody is watching a run started by this: a routine's firing or a check-in (a check-in
 * runs as a routine-kind initiator, see `proactiveInitiator`), or work one of those handed on. Such
 * a run has to finish on its own, so it gets the step budget for that (`UNATTENDED_STEPS`).
 */
export function runsUnattended(initiator: AuditInitiator | undefined): boolean {
  if (!initiator) return false;
  if (initiator.kind === "routine") return true;
  if (initiator.kind === "handoff") return runsUnattended(initiator.origin);
  return false;
}
