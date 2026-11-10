import type { RunMode } from "@openbot/shared/bot-prompt";
import type { AuditInitiator } from "../audit";
import { isProactiveInitiator } from "../proactive/initiator";

/**
 * Whether anybody is watching a run, read from what started it.
 *
 * A person's own turn is attended. A routine-kind run is not: a routine firing, on its schedule or
 * from Run now (`routines/runner.ts`), and a follow-up the Bot set for itself (`agents/wake-up.ts`).
 * A proactive check-in carries a routine-kind initiator too, named as one (`proactive/initiator.ts`),
 * and gets its own mode because its instruction already says how it finishes. A goal's run
 * (`responsibility`) runs with nobody watching as well. A handoff runs as whatever started the chain.
 *
 * Absent means a run nobody said anything about, which is a person's run in the browser: the
 * runtime's own request path passes no initiator.
 */
export function runModeOf(
  initiator: AuditInitiator | undefined | null,
): RunMode {
  if (!initiator) return "attended";
  if (isProactiveInitiator(initiator)) return "check-in";
  switch (initiator.kind) {
    case "routine":
    case "responsibility":
      return "routine";
    case "handoff":
      return runModeOf(initiator.origin);
    default:
      return "attended";
  }
}

/** Whether nobody is watching a run of this mode, so it has to finish on its own. */
export function isUnattended(mode: RunMode | undefined): boolean {
  return mode !== undefined && mode !== "attended";
}
