/**
 * What the run harness says to the model when a run is about to end unfinished.
 *
 * Every sentence the harness itself puts in front of the model lives here and nowhere else, so the
 * wording can be changed in one place without touching the mechanism that decides when to send it
 * (`toolkit/src/copilotkit/last-step.ts`). Each one is sent as a one-turn message: it is added to
 * the prompt of the call it is for and never written to the conversation, so the person never sees
 * it and the next run never inherits it.
 */

/**
 * Sent with a run's last step, which goes to the model with its tools switched off.
 *
 * Before this the step was silent: the model was handed no tools and no reason, and a routine
 * twenty lookups deep ended "I'll fetch the rest now" on a step where it could fetch nothing.
 */
export const LAST_STEP_NOTICE =
  "This is the last step of this run, so your tools are now off. Answer now from what you already have: give the result first, then say what you did not get to and why.";

/**
 * Sent when a run's answer ends on a promise of work it did not do: "I'll fetch the rest now", and
 * no call after it. `promise` is the model's own sentence, quoted back as it wrote it.
 */
export function promiseNudge(promise: string): string {
  return `You said "${promise}" but made no tool call. Do it now, or finish with the result and what is missing.`;
}

/** One part of a routine's checklist, by its number, as a nudge lists it. */
export type OpenPart = { number: number; text: string };

/** Sent when a routine's answer leaves parts of its checklist open, alone or after a promise. */
export function openPartsNudge(open: readonly OpenPart[]): string {
  const listed = open.map((part) => `${part.number}. ${part.text}`).join("; ");
  return `These parts of the routine are still open: ${listed}. Do them now, or close each one by its number as Done, Blocked (with the reason) or Skipped (with the reason).`;
}

/**
 * The checklist a multi-part routine's firing carries, added under the instruction for the model.
 * The parts are the instruction's own list items, numbered as the model is asked to close them.
 */
export function checklistNotice(parts: readonly string[]): string {
  return [
    `This routine has ${parts.length} parts. Before you finish, close every one by its number: Done, Blocked (with the reason) or Skipped (with the reason).`,
    ...parts.map((part, index) => `${index + 1}. ${part}`),
  ].join("\n");
}
