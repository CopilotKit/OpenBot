/**
 * What a Bot is told when a step it asked for was not carried out by it, and what the person sees
 * for the same step.
 *
 * The sentences below are written to the model: they say who decided, and what to do next, so the
 * Bot reports it truthfully and does not go looking for another way round. The same text came back
 * as the step's result and was drawn as it stood, in the transcript beside "Ran a command" and in
 * the Computer panel's Activity, so a person read "Do not try this action ... again" about their own
 * decision. They live here, beside {@link outcomeForPerson}, so the app can translate exactly the
 * sentences the server sends, and a change to one cannot leave the other behind.
 *
 * EVERY SENTENCE THE SERVER ANSWERS A STEP WITH IS EXPORTED FROM HERE, the fixed ones as constants
 * and the ones that carry a reason as functions. `server/tests/approval-outcomes-for-person.test.ts`
 * walks these exports and the approval service's, and fails on any that a person would still read in
 * the words written for the Bot, so a sentence added later cannot leak by being forgotten here.
 */

/**
 * What the Bot is told when the person says no. Plain, and distinct from a policy or boundary
 * refusal, so the model reports it truthfully and does not go looking for another way round it.
 */
export const DECLINED_BY_PERSON =
  "The person declined this action when you asked for their approval, so it was not done. This was their decision, not a policy or a boundary. Do not try this action, or anything equivalent, again in this conversation unless the person asks you to in words; tell them you did not do it because they declined.";
/** What a Bot retrying an action that is still waiting is told, instead of opening a second request. */
export const ALREADY_WAITING =
  "An identical request is already waiting for the person's decision on the Bot's page in OpenBot, so this was not done and no second request was made. Do not repeat it; wait for their answer.";
export const WITHDRAWN_APPROVALS_OFF =
  "Not done: this request was withdrawn because the person switched off asking before changes. Try the action again if it is still needed.";
export const WITHDRAWN_RULE_ALLOWS =
  "Not done: this request was withdrawn because a rule the person saved now allows it without asking. Try the action again if it is still needed.";
/**
 * What a hand-off answers the Bot with once the person has done it themselves.
 *
 * Not a refusal, and the one sentence here that is not "not done": the thing was done, by the
 * person. See {@link doneByPerson}.
 */
export const HANDLED_BY_PERSON =
  "The person did this themselves. Do not repeat it; continue from what they have done.";
/**
 * An approved step that started, on a process that stopped before saving what happened. Repeating it
 * could do it twice, so it is not repeated, and the Bot is told to find out.
 */
export const OUTCOME_UNKNOWN =
  "This action was started but its outcome is unknown. It was not repeated. Check whether it happened before asking the person again.";
/** An approved step that was turned away by the check just before it ran, with no reason of its own. */
export const NOT_DONE = "Not done.";

/**
 * An approved step that the check just before it ran turned away. `why` is one sentence, with its
 * full stop, written for whoever reads it ("The rule that allowed this was removed before it ran.").
 */
export function notDoneOnRecheck(why: string): string {
  return `Not done: ${why} Ask the person again if it is still needed.`;
}

/** An approved step whose work ran out of tries, with what stopped it. */
export function notCarriedOut(reason: string): string {
  return `Not done: this action could not be carried out (${reason.slice(0, 300)}). Check whether it happened before asking the person again.`;
}

const FOR_PERSON = new Map<string, string>([
  [DECLINED_BY_PERSON, "You declined it."],
  [ALREADY_WAITING, "It's already waiting for your answer."],
  [WITHDRAWN_APPROVALS_OFF, "Withdrawn. You turned off asking before changes."],
  [WITHDRAWN_RULE_ALLOWS, "Withdrawn. A rule you saved now allows it."],
  [HANDLED_BY_PERSON, "You did it yourself."],
  [
    OUTCOME_UNKNOWN,
    "It started, but OpenBot can't tell whether it finished. It wasn't run again.",
  ],
]);

/**
 * The sentence a person reads for a step the Bot did not carry out. A known sentence is replaced
 * whole. Any other "Not done: <why>." keeps its first sentence and loses what follows it, which is
 * the Bot's next step ("Ask the person again if it is still needed."). Anything else is a boundary
 * or the computer speaking, already written for a person, and is returned as it is.
 */
export function outcomeForPerson(text: string): string {
  const known = FOR_PERSON.get(text.trim());
  if (known) return known;
  if (!text.startsWith("Not done:")) return text;
  const end = firstSentenceEnd(text);
  return end === -1 ? text : text.slice(0, end + 1);
}

/**
 * Whether a step's answer says the person did it themselves. That step was done, by them, and is
 * drawn as done, not as refused: nothing was turned away.
 */
export function doneByPerson(text: string): boolean {
  return text.trim() === HANDLED_BY_PERSON;
}

/**
 * Whether a step's answer says the person declined it. Refused like a boundary's no, but the
 * person's own decision, so it is said as theirs.
 */
export function declinedByPerson(text: string): boolean {
  return text.trim() === DECLINED_BY_PERSON;
}

/** Where the first sentence ends: a full stop followed by a space, outside any parentheses. */
function firstSentenceEnd(text: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "." && depth === 0 && text[index + 1] === " ")
      return index;
  }
  return -1;
}
