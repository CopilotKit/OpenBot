/**
 * A Bot as the person's point of contact: it answers short asks itself, reacts to a message that
 * needs only an acknowledgement, and hands real work into a task thread of its own, coming back to
 * the conversation with the result.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES. The server offers these tools, runs them and writes the
 * task's reports into the conversation; the browser draws the calls and the reports from the same
 * names, ids and result shapes. The reasons are the ones `handoff-markers.ts` gives.
 */

/** Hand a piece of work into a task thread of the Bot's own. */
export const DELEGATE_TOOL = "delegate";
/** React to the person's message instead of writing a line. */
export const REACT_TOOL = "react";
/** Find a task thread this conversation started, to give the person its link. */
export const LINK_TOOL = "link_to_thread";

/** The reactions a Bot may leave. A short list, so a reaction always reads as an acknowledgement. */
export const REACTIONS = ["👍", "❤️", "🎉", "👀", "✅", "🙏", "😂"] as const;

/**
 * How a Bot is the person's point of contact, when it holds `delegate`: each turn it answers, reacts,
 * or says in a line what it will do and hands the work into a task thread, which reports back. Its
 * own model decides, guided by this; nothing else does. Given to a Bot as its own prompt section
 * ("delegating"), after the working rules.
 *
 * Conditional on holding the tool, because the task thread's own turn reads the same prompt and holds
 * no such tool, and a routine or a check-in is offered none.
 *
 * GENERATIVE UI IS NOT GIVEN UP FOR IT. A direct answer still draws a component when it has
 * structure, as the answer-format rules say; the work in a task thread draws its own, and they are
 * carried back into the conversation with its result. So the Bot is told both, rather than learning
 * that delegating means a plain line and a link.
 */
export const DELEGATING_GUIDANCE = [
  `When you hold ${DELEGATE_TOOL}, you are the person's point of contact and real work runs in task threads of your own, so this conversation stays short. Each turn, do one of three things:`,
  "- Answer directly when the ask is short: a question you can answer from what you know or from this conversation, or with one quick read. Draw a component when the answer has structure, as you always do.",
  `- React with ${REACT_TOOL} when the message needs only an acknowledgement, such as a thank-you or an 'ok': the reaction is your whole answer.`,
  `- Otherwise, write one short line saying what you will do ("On it, I'll check the venue's listing.") and call ${DELEGATE_TOOL} in the same reply with a brief that stands on its own. Do not do the work yourself as well, and do not wait for it. When it finishes, its result, with every chart, table or card it drew, is posted in this conversation; if it needs the person, this conversation says so with a link to the thread where it waits.`,
  `When the person asks for the link to a task's thread, call ${LINK_TOOL} and give them the link.`,
].join("\n\n");

/** What `delegate` answers when the task started, and what its card is drawn from. */
export type DelegateResult = {
  taskId: string;
  /** The task's own conversation, where the work runs. */
  channelId: string;
  title: string;
  /** For the model: what happens next, so it neither waits nor does the work itself. */
  next: string;
};

/** One task thread as `link_to_thread` answers with it. */
export type LinkedThread = {
  taskId: string;
  channelId: string;
  title: string;
  /** Where it stands, in the task list's words (`TaskStatus`). */
  status: string;
  /** The path that opens it in the app. */
  link: string;
};

/** What `link_to_thread` answers. */
export type LinkResult = { threads: LinkedThread[] };

function parsedObject(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
    // The runtime may carry a tool's string answer encoded once more.
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
  } catch {
    return null;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** The started task, read back from a `delegate` result, or null for a refusal or anything else. */
export function readDelegateResult(text: unknown): DelegateResult | null {
  const result = parsedObject(text);
  if (
    !result ||
    typeof result.taskId !== "string" ||
    typeof result.channelId !== "string" ||
    typeof result.title !== "string"
  )
    return null;
  return result as DelegateResult;
}

/** The threads, read back from a `link_to_thread` result, or null for anything else. */
export function readLinkResult(text: unknown): LinkResult | null {
  const result = parsedObject(text);
  if (!result || !Array.isArray(result.threads)) return null;
  const threads = result.threads.filter(
    (thread): thread is LinkedThread =>
      typeof thread === "object" &&
      thread !== null &&
      typeof (thread as LinkedThread).taskId === "string" &&
      typeof (thread as LinkedThread).channelId === "string" &&
      typeof (thread as LinkedThread).title === "string",
  );
  return { threads };
}

/** The path a task thread opens at in the app. */
export function threadPath(channelId: string): string {
  return `/channel/${channelId}`;
}

/**
 * What a task says in the conversation that asked for it.
 *
 * `result`: the work finished, and this is what it found. `needs`: it waits on the person, in its
 * own thread. `failed`: it ran out of tries.
 */
export type TaskReportKind = "result" | "needs" | "failed";

/**
 * What the message id of a task's report starts with, in the conversation that asked.
 *
 * The report is written into that conversation by the deployment, as the Bot's own message, so the
 * transcript has to be told it is a report, and of which task, some other way than its words. The id
 * is the one field every reader keeps (see `ANSWER_ID_PREFIX`).
 */
export const TASK_REPORT_PREFIX = "task-report:";

/** The id a task's report carries, unique per report. */
export function taskReportMessageId(
  kind: TaskReportKind,
  taskId: string,
  runId: string,
): string {
  return `${TASK_REPORT_PREFIX}${kind}:${taskId}:${runId}`;
}

/** The report this message is, or null for every other message. */
export function readTaskReport(
  messageId: string,
): { kind: TaskReportKind; taskId: string } | null {
  if (!messageId.startsWith(TASK_REPORT_PREFIX)) return null;
  const [kind, taskId] = messageId.slice(TASK_REPORT_PREFIX.length).split(":");
  if (kind !== "result" && kind !== "needs" && kind !== "failed") return null;
  if (!taskId) return null;
  return { kind, taskId };
}

/**
 * The words in front of the brief, in the task thread's first message.
 *
 * Addressed to the model doing the work: it is in a thread of its own, and its opening sentences are
 * what the person reads back in the conversation that asked, with any component it draws. So it is
 * asked to lead with the result and to draw components as it would in that conversation, never to
 * write plainer because the work moved.
 */
const BRIEF_FRAME = [
  "This is a task from your conversation with the person, handed into a thread of its own so that conversation stays short. Do the work here with your tools, as you would there, and finish it.",
  "Answer the way you always do: when the answer has structure (figures, a comparison, a list of items, a plan, a record), draw it with a component rather than writing it out.",
  "Begin your reply with one or two sentences that give the result and say plainly anything you could not confirm. Those sentences and any components you draw are posted back in that conversation; the rest stays in this thread.",
  "The task:",
];

/** The frame and the blank line under it, which is what `readBrief` strips. */
const BRIEF_PREFIX = [...BRIEF_FRAME, "", ""].join("\n");

/** The brief, wrapped in the words that tell the turn it is a delegated task. */
export function frameBrief(brief: string): string {
  return `${BRIEF_PREFIX}${brief}`;
}

/** The brief back out of a framed message, or null if this was not one. See `readFiring`. */
export function readBrief(text: string): string | null {
  if (!text.startsWith(BRIEF_PREFIX)) return null;
  return text.slice(BRIEF_PREFIX.length);
}

/** A paragraph that is a Markdown table: a header row, then its `---` divider. */
const TABLE = /^\s*\|.*\|\s*\n\s*\|?\s*:?-{3,}/;

/**
 * What a task's reply says in the conversation that asked for it: its short opening, and every table
 * the reply drew in Markdown, under it.
 *
 * A table is generative UI as much as a component is: the transcript draws it as one, with copy,
 * download and full screen. A result that carried only the opening sentence made the answer plainer
 * for having moved into a thread, so a table the work made comes back with it, as a chart or a card
 * the work drew comes back as its component (tasks/reports.ts).
 */
export function resultForConversation(reply: string): string {
  const opening = shortResult(reply);
  const tables = reply
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(
      (paragraph) => TABLE.test(paragraph) && !opening.includes(paragraph),
    );
  return [opening, ...tables].filter(Boolean).join("\n\n");
}

/** How long the short result posted back may be, in characters. One or two sentences. */
export const SHORT_RESULT_MAX = 480;

/**
 * The short result a task's reply leads with: its first paragraph of prose, clipped.
 *
 * The task was asked to lead with one or two sentences giving the result (see `BRIEF_FRAME`). A
 * reply that opens with a heading or a list instead still has a first paragraph of prose somewhere;
 * one that has none gives its first paragraph, whatever it is.
 */
export function shortResult(reply: string): string {
  const paragraphs = reply
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => /[\p{L}\p{N}]/u.test(paragraph));
  const prose =
    paragraphs.find(
      (paragraph) => !/^(#{1,6}\s|[-*+•]\s|\d+[.)]\s|>|```|\|)/.test(paragraph),
    ) ??
    paragraphs[0] ??
    "";
  const characters = Array.from(prose);
  if (characters.length <= SHORT_RESULT_MAX) return prose;
  const cut = characters.slice(0, SHORT_RESULT_MAX - 1).join("");
  const sentence = cut.match(/^[\s\S]*[.!?](?=\s)/)?.[0];
  return sentence && sentence.length > SHORT_RESULT_MAX / 3
    ? sentence
    : `${cut.trimEnd()}…`;
}
