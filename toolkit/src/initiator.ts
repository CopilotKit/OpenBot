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
