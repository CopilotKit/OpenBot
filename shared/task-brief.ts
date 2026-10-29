/**
 * The sentences that tell the Bot a conversation is a task of its own, declared once and read from
 * both sides.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, for the reason `routine-firing.ts` gives. A task starts in a
 * conversation of its own with the person's ask as its first message (`start_task`, or Start on a
 * suggestion), and the turn is started by the server, not typed there. The model needs telling that
 * this conversation IS the task: its prompt says to hand anything bigger than a quick answer to
 * `start_task`, and a task whose first message reads like that ask would hand itself on again,
 * forever. Two readers have to recognise the frame again: the transcript, to draw the person's ask
 * as their own words without the frame, and the titler, to name the conversation from the ask.
 */

/** The tool that hands work to a task of its own. Named here so the frame and the tool agree. */
export const START_TASK_TOOL = "start_task";

export const TASK_FRAME = [
  "This conversation is a task the person handed you. It runs on its own, apart from their Chat, and they read it when they open the task.",
  `Do the work here yourself, all of it, and end with what you did and anything still waiting on them. Never call ${START_TASK_TOOL} in this conversation: this is the task.`,
] as const;

/**
 * How a task's turn should end, sent as a system message on its turns rather than in the frame,
 * which has to stay word for word so earlier tasks are still read as tasks.
 *
 * A reply that ends on a question reads as Needs you in Tasks (`replyEnding`), so the Bot asks one
 * only when it cannot go on without an answer. Without this, "end with what you did and anything
 * still waiting on them" came back as literal "What I did:" and "Still waiting on you:" labels, the
 * second of them on the list's next-step line.
 */
export const TASK_ENDING =
  'End with a sentence or two in plain words on what you did. Ask the person a question only if you need their answer to go on, and never end by offering more work as a question. Don\'t label these parts, as in "What I did:" or "Still waiting on you:".';

/** The historical frame and blank line remain the prefix of correction messages. */
const PREFIX = [...TASK_FRAME, "", ""].join("\n");
// The label precedes the blank line, so this cannot match a historical frame's arbitrary body.
// Everything after this distinct prefix is the ask, including any quoted framing syntax.
const BRIEF_PREFIX = [...TASK_FRAME, "The person's task:", "", ""].join("\n");

/** The person's ask, wrapped in the sentences that tell the turn it is a task's own conversation. */
export function frameTaskBrief(ask: string): string {
  return `${BRIEF_PREFIX}${ask}`;
}

/**
 * The line between the ask and the person's reply, when they reply to a task that couldn't finish.
 * The run gets the task and their words both; the transcript shows only their words.
 */
export const TASK_REPLY_LINE =
  "The run before this one couldn't finish. The person replied to the task with this:";

const REPLY_SEPARATOR = `\n\n${TASK_REPLY_LINE}\n\n`;
// JavaScript string offsets count UTF-16 code units. A length makes the boundary independent of
// earlier framed retries and anything the person quoted, without changing either person's text.
const CONTEXT_LENGTH_PREFIX = "Earlier task input (UTF-16 length): ";

/** A reply to a failed task: the ask under the frame for the model, then the person's own words. */
export function frameTaskReply(ask: string, reply: string): string {
  return `${PREFIX}${CONTEXT_LENGTH_PREFIX}${ask.length}\n${ask}${REPLY_SEPARATOR}${reply}`;
}

// Distinct from historical framing, whose next line is blank. JSON keeps accepted data on one line.
const INPUT_PREFIX = [...TASK_FRAME, "Accepted task reply identity: "].join(
  "\n",
);

/** Persist accepted words and identity independently of execution framing and user-message IDs. */
export function frameTaskInput(
  text: string,
  acceptedReply: { id: string; text: string },
): string {
  return `${INPUT_PREFIX}${JSON.stringify(acceptedReply)}\n\n${text}`;
}

/**
 * Decode the task input's kind and exact person-authored text, including historical encodings.
 * A whole-frame prefix match means quoting just one instruction line is not mistaken for a frame.
 */
export function readTaskFrame(
  text: string,
): { kind: "brief" | "reply"; text: string; inputId?: string } | null {
  if (!text.startsWith(INPUT_PREFIX)) return readTaskContent(text);
  const end = text.indexOf("\n\n", INPUT_PREFIX.length);
  if (end === -1) return null;
  let accepted: { id?: unknown; text?: unknown } | null;
  try {
    accepted = JSON.parse(text.slice(INPUT_PREFIX.length, end));
  } catch {
    return null;
  }
  if (
    typeof accepted?.id !== "string" ||
    !accepted.id ||
    typeof accepted.text !== "string"
  )
    return null;
  // Accepted words are opaque: even a complete task frame quoted by the person stays literal.
  return { kind: "reply", text: accepted.text, inputId: accepted.id };
}

function readTaskContent(
  text: string,
): { kind: "brief" | "reply"; text: string } | null {
  if (text.startsWith(BRIEF_PREFIX))
    return { kind: "brief", text: text.slice(BRIEF_PREFIX.length) };
  if (!text.startsWith(PREFIX)) return null;
  const rest = text.slice(PREFIX.length);
  if (rest.startsWith(CONTEXT_LENGTH_PREFIX)) {
    const lineEnd = rest.indexOf("\n");
    const length = rest.slice(CONTEXT_LENGTH_PREFIX.length, lineEnd);
    const offset = lineEnd + 1 + Number(length);
    if (
      /^\d+$/.test(length) &&
      Number.isSafeInteger(offset) &&
      rest.startsWith(REPLY_SEPARATOR, offset)
    )
      return {
        kind: "reply",
        text: rest.slice(offset + REPLY_SEPARATOR.length),
      };
  }
  // Historical frames have no length. Keep their first-separator contract so a separator quoted
  // inside the person's reply is still part of their words.
  const reply = rest.indexOf(REPLY_SEPARATOR);
  return reply === -1
    ? { kind: "brief", text: rest }
    : { kind: "reply", text: rest.slice(reply + REPLY_SEPARATOR.length) };
}

/** The person's ask or latest correction, or null if the message has no task frame. */
export function readTaskBrief(text: string): string | null {
  return readTaskFrame(text)?.text ?? null;
}
