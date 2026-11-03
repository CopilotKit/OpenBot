/**
 * What a Bot is told when a step it asked for was not carried out, and what the person sees for the
 * same step.
 *
 * The sentences below are written to the model: they say who decided, and what to do next, so the
 * Bot reports it truthfully and does not go looking for another way round. The same text came back
 * as the step's result and was drawn as it stood, in the transcript beside "Ran a command" and in
 * the Computer panel's Activity, so a person read "Do not try this action ... again" about their own
 * decision. They live here, beside {@link outcomeForPerson}, so the app can translate exactly the
 * sentences the server sends, and a change to one cannot leave the other behind.
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

const FOR_PERSON = new Map<string, string>([
  [DECLINED_BY_PERSON, "You declined it."],
  [ALREADY_WAITING, "It's already waiting for your answer."],
  [WITHDRAWN_APPROVALS_OFF, "Withdrawn. You turned off asking before changes."],
  [WITHDRAWN_RULE_ALLOWS, "Withdrawn. A rule you saved now allows it."],
]);

/**
 * The sentence a person reads for a step that was not carried out. A known sentence is replaced
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
