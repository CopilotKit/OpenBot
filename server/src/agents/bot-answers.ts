/**
 * Another Bot's answer, put in front of the model as another Bot's words.
 *
 * A `message_bot` answer lands in the asking Bot's thread as an assistant message, because an
 * Intelligence thread has one agent and an assistant message is the only kind a Bot's thread admits
 * from anybody but the person. The id says whose it is (`answerMessageId`), and that is all the
 * screen needs. The model reads none of it: AG-UI's `name` is dropped by the platform's read and by
 * the runtime's conversion, and Anthropic has no per-message name at all. So the asking Bot was sent
 * the answer as a turn of its own. Asked on the next turn to quote what Knowledge said, General
 * Assistant answered that Knowledge's reply never appeared, and that the sentence was its own.
 *
 * THE SHAPE. Each such message goes to the model as a user turn that says which Bot answered and
 * quotes the answer inside the untrusted-content envelope every outside text gets. The frameworks
 * that run several agents over one conversation say whose words they are in the text the model
 * reads: LangGraph's supervisor writes the agent's name into the content for providers with no
 * `name` field, and the OpenAI Agents SDK hands a previous agent's turns to the next one as a
 * transcript with each turn labelled. This also takes the answer out of the assistant role, because
 * a name written inside the model's own turn still leaves the words in its mouth, and that is the
 * failure that was seen. The envelope, because a user turn otherwise carries the person's
 * authority, and an answer built from a document another Bot read is not the person asking for
 * anything.
 *
 * THE PAIRING. A user turn is where the model API stops looking for a tool call's result (see
 * `boundaryAfter` in `toolkit/history-sanitize.ts`), and an assistant turn was not. So an answer
 * that landed while a call of the asking Bot's was still open, which an approval that suspended the
 * run allows, would orphan that call once re-roled. It is moved back to the last point where no call
 * was open instead: the answer reads slightly earlier, and every call keeps its result. Run after
 * the sanitiser, so every call still here has a result or is answered by the run's resume.
 *
 * Ids are kept, so a pass that subtracts history by id still finds it, and nothing here is stored:
 * the screen keeps reading the thread as it always did.
 */
import type { Message, ToolCall } from "@ag-ui/client";
import { answeredBy } from "@openbot/shared/handoff-markers";
import { markUntrusted } from "../untrusted-content";

/** The text of a message, whichever shape its content takes. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" &&
      part !== null &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
}

/**
 * The words the model reads in place of another Bot's answer.
 *
 * `name` is absent for a Bot this person no longer has on their roster, which still answered.
 */
export function botAnswerTurn(name: string | undefined, text: string): string {
  const who = name ? `${name}, another Bot,` : "Another Bot";
  const whose = name ? `${name}'s answer` : "another Bot's answer";
  return [
    `${who} answered work that was handed to it with message_bot. You did not write this answer, and the person did not say it. Here is ${whose}, word for word:`,
    markUntrusted(text, whose),
  ].join("\n");
}

/**
 * The history with every handed-over answer turned into a user turn that says whose it is.
 *
 * `names` maps a Bot's id to its display name. A history with no such answer comes back as the same
 * array, which is nearly every conversation.
 */
export function attributeBotAnswers(
  history: Message[],
  names: ReadonlyMap<string, string>,
): Message[] {
  const answerer = (message: Message) => {
    if (message.role !== "assistant") return null;
    // An answer is said, never a tool call. A message carrying calls is the Bot's own work.
    if ((message as { toolCalls?: ToolCall[] }).toolCalls?.length) return null;
    return answeredBy(message.id);
  };
  if (!history.some((message) => answerer(message) !== null)) return history;

  const out: Message[] = [];
  const open = new Set<string>();
  /** Where a user turn can go without coming between a call and its result. */
  let quiet = 0;
  for (const message of history) {
    const botId = answerer(message);
    if (botId !== null) {
      out.splice(quiet, 0, {
        id: message.id,
        role: "user",
        content: botAnswerTurn(names.get(botId), textOf(message.content)),
      });
      quiet += 1;
      continue;
    }
    out.push(message);
    for (const call of (message as { toolCalls?: ToolCall[] }).toolCalls ?? [])
      open.add(call.id);
    const { toolCallId } = message as { toolCallId?: string };
    if (toolCallId !== undefined) open.delete(toolCallId);
    if (open.size === 0) quiet = out.length;
  }
  return out;
}
