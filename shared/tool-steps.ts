import { isDecisionTool } from "./decision-tools";

/**
 * A step: the tool calls a model asks for in one response, which AG-UI carries as one assistant
 * message. Claude asks for several at once by default, and other models can too. Whichever model a
 * Bot runs on, OpenBot holds a step to the pattern Anthropic documents for parallel tool use
 * (https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use): the API does
 * not say what order the calls run in, so the side that runs them decides.
 *
 * A COMPUTER'S ACTIONS RUN ONE AT A TIME, IN ORDER, AND STOP AT THE FIRST FAILURE. A form's worth of
 * typing sent together took the focus from each other and dropped values. Each one after a failure
 * is answered as not run, because the page is no longer the one the Bot planned it on.
 *
 * A COMPONENT IS DRAWN ONLY FROM RESULTS ALREADY READ. Seen on Claude: General Assistant asked for
 * its searches and the chart and table meant to show them in one step, so the figures were written
 * before any search came back. A component in the same step as any other kind of call is not drawn,
 * and its call is answered as an error, so the Bot draws it again from the results. A component on
 * its own, or beside other components only, is drawn as it always was.
 *
 * Read from both sides: the browser and the server's headless turns answer calls with these
 * sentences, and the transcript reads them back.
 */

/** One call of a step, as AG-UI and the AI SDK both shape it. */
export type StepCall = { id: string; function: { name: string } };

/** A message as far as finding a step needs: an assistant message carries its calls. */
type StepMessage = { role: string; toolCalls?: readonly StepCall[] };

/** Whether a call drives a computer: its browser, its files or its shell. */
export function isComputerCall(name: string): boolean {
  return name.startsWith("computer_");
}

/** What a component drawn too early is answered with. Written for the model. */
export const NOT_DRAWN =
  "Not drawn: you called this in the same step as other tools, before their results came back. Draw it now, from those results.";

/** The same, for a card that asks the person something: an approval, a choice or a form. */
export const NOT_ASKED =
  "Not asked: you called this in the same step as other tools, before their results came back. Ask it now, from those results.";

/** The answer for a component called too early, by what it is. */
export function drawnTooEarlyAnswer(name: string): string {
  return isDecisionTool(name) ? NOT_ASKED : NOT_DRAWN;
}

/** Whether a call's answer says it was called too early, so nothing of it is drawn. */
export function answeredTooEarly(content: unknown): boolean {
  if (typeof content !== "string") return false;
  const text = content.trim();
  return text === NOT_DRAWN || text === NOT_ASKED;
}

/**
 * The components of a step that are not drawn: every one of them, when the step also holds a call
 * that is not a component. `isComponent` says which calls draw a component; a call it does not know
 * is not one.
 */
export function drawnTooEarly(
  calls: readonly StepCall[],
  isComponent: (name: string) => boolean,
): ReadonlySet<string> {
  const mixed = calls.some((call) => !isComponent(call.function.name));
  if (!mixed) return new Set();
  return new Set(
    calls
      .filter((call) => isComponent(call.function.name))
      .map((call) => call.id),
  );
}

/** The calls of the step that holds this one, or undefined when no message holds it. */
export function stepOf(
  messages: readonly StepMessage[],
  toolCallId: string,
): readonly StepCall[] | undefined {
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.toolCalls))
      continue;
    if (message.toolCalls.some((call) => call?.id === toolCallId))
      return message.toolCalls;
  }
  return undefined;
}

/** An answer that is a real one, not a stand-in the transport put there while the call waits. */
function settled(result: string | undefined): boolean {
  const text = result?.trim();
  return (
    !!text &&
    text !== "Forwarded to client" &&
    text !== '"Forwarded to client"' &&
    text !== '{"waiting":true}'
  );
}

/**
 * Whether a transcript leaves a component call out, given the calls of its step and its answer.
 *
 * Answered as asked for too early, or not answered yet in a step that asked for another kind of call
 * too: left out while it streams, so it never shows for a moment before its answer arrives. One
 * answered as drawn is drawn whatever its step holds, so a conversation stored before this rule still
 * shows what it showed.
 */
export function leftOutOfTranscript(
  calls: readonly StepCall[],
  call: StepCall,
  result: string | undefined,
  isComponent: (name: string) => boolean,
): boolean {
  if (!isComponent(call.function.name)) return false;
  if (answeredTooEarly(result)) return true;
  if (settled(result)) return false;
  return drawnTooEarly(calls, isComponent).has(call.id);
}

/** Whether this call is a component that its step asked for too early. */
export function calledTooEarly(
  messages: readonly StepMessage[],
  toolCallId: string,
  isComponent: (name: string) => boolean,
): boolean {
  const step = stepOf(messages, toolCallId);
  return step ? drawnTooEarly(step, isComponent).has(toolCallId) : false;
}
