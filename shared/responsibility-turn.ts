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
/**
 * A goal that repeats: why, then what its run does. Every run of one meets its success criteria, and
 * a run told only to record progress completed the goal it was one run of. Inside the scaffolding
 * that `readResponsibilityTurn` takes back apart, so the person's instruction is drawn as it was.
 */
const REPEATS = "\n\nThis goal repeats because ";
const ONE_OF_MANY =
  ". This run is one of many: record its result with report_goal_progress, and the goal stays active. Only the person ends it. If it looks finished for good, say so in your reply.";
const REPORT =
  "\n\nRecord meaningful progress with report_goal_progress for goal ";
/**
 * The same line as every turn was sent before a goal's tools said goal. A conversation recorded then
 * still has it, and is still drawn as a goal's turn.
 */
const REPORTED_AS_RESPONSIBILITY =
  "\n\nRecord meaningful progress with report_responsibility_progress for responsibility ";

export type ResponsibilityTurnParts = {
  instruction: string;
  successCriteria: string;
  progress: string;
  trigger: { source: string; type: string };
  /** The event payload, already wrapped in its untrusted envelope by the caller. */
  eventData: string;
  responsibilityId: string;
  /** Why the goal repeats, in words ("a routine runs it"), when it does. */
  repeats?: string;
};

/** The model-facing message for one responsibility turn. */
export function buildResponsibilityTurn(
  parts: ResponsibilityTurnParts,
): string {
  const repeats = parts.repeats
    ? `${REPEATS}${parts.repeats}${ONE_OF_MANY}`
    : "";
  return `${parts.instruction}${CRITERIA}${parts.successCriteria}${PROGRESS}${parts.progress || "No progress recorded yet."}${TRIGGER}${parts.trigger.source}/${parts.trigger.type}${EVENT}${parts.eventData}${repeats}${REPORT}${parts.responsibilityId}.`;
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
  // Whichever line comes last is the turn's own: event data may quote either.
  const [marker, report] = [REPORT, REPORTED_AS_RESPONSIBILITY]
    .map((each) => [each, text.lastIndexOf(each)] as const)
    .reduce((last, each) => (each[1] > last[1] ? each : last));
  if (report === -1 || !text.endsWith(".")) return null;
  const responsibilityId = text.slice(report + marker.length, -1);
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
