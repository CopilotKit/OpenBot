/**
 * The message a responsibility's turn is sent as, declared once and read from both sides.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, for the same reason `routine-firing.ts` gives: the server
 * writes this text to the model, the routine runner persists it to the transcript, and the browser
 * has to recognise it again to draw it for a person. Two copies of the layout would be a contract
 * with two authors, and the first rewording would break the renderer silently.
 *
 * Everything below the person's instruction is scaffolding addressed to the model: the success
 * criteria, the progress so far, the trigger, the untrusted event envelope and the reminder to
 * report progress. A person reading the transcript wrote the instruction and chose the trigger; the
 * rest is how the turn was put to the model, so {@link readResponsibilityTurn} takes it back apart.
 */

const CRITERIA = "\n\nSuccess criteria: ";
const PROGRESS = "\nProgress so far: ";
const TRIGGER = "\nTrigger: ";
const EVENT = "\nEvent data:\n";
const REPORT =
  "\n\nRecord meaningful progress with report_responsibility_progress for responsibility ";

export type ResponsibilityTurnParts = {
  instruction: string;
  successCriteria: string;
  progress: string;
  trigger: { source: string; type: string };
  /** The event payload, already wrapped in its untrusted envelope by the caller. */
  eventData: string;
  responsibilityId: string;
};

/** The model-facing message for one responsibility turn. */
export function buildResponsibilityTurn(
  parts: ResponsibilityTurnParts,
): string {
  return `${parts.instruction}${CRITERIA}${parts.successCriteria}${PROGRESS}${parts.progress || "No progress recorded yet."}${TRIGGER}${parts.trigger.source}/${parts.trigger.type}${EVENT}${parts.eventData}${REPORT}${parts.responsibilityId}.`;
}

export type ResponsibilityTurn = {
  /** What the person asked the responsibility to do, exactly as it was stored. */
  instruction: string;
  /** `source/type`, as the turn was told it. */
  trigger: string;
  responsibilityId: string;
};

/**
 * The person-facing parts back out of a responsibility turn, or null if this text is not one.
 *
 * The instruction ends at the FIRST criteria marker and the trigger is the first `Trigger:` line
 * after it: the event data comes last and is outside content, so nothing inside it is allowed to
 * decide where the earlier fields end.
 */
export function readResponsibilityTurn(
  text: string,
): ResponsibilityTurn | null {
  const report = text.lastIndexOf(REPORT);
  if (report === -1 || !text.endsWith(".")) return null;
  const responsibilityId = text.slice(report + REPORT.length, -1);
  if (!/^[\w-]+$/.test(responsibilityId)) return null;

  const criteria = text.indexOf(CRITERIA);
  if (criteria === -1 || criteria > report) return null;
  const progress = text.indexOf(PROGRESS, criteria + CRITERIA.length);
  if (progress === -1 || progress > report) return null;
  const trigger = text.indexOf(TRIGGER, progress + PROGRESS.length);
  if (trigger === -1 || trigger > report) return null;
  const event = text.indexOf(EVENT, trigger + TRIGGER.length);
  if (event === -1 || event > report) return null;

  return {
    instruction: text.slice(0, criteria),
    trigger: text.slice(trigger + TRIGGER.length, event),
    responsibilityId,
  };
}
