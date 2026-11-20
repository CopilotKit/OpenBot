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
/** Tell a task this conversation started something more, as the person's message in its thread. */
export const FOLLOW_UP_TOOL = "follow_up";
/** Stop a task this conversation started, as Stop on its card does. */
export const STOP_TOOL = "stop";

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
 *
 * THE WORK IS NAMED, NOT LEFT TO "OTHERWISE". This said to answer "a short ask" and delegate the
 * rest, and a LangGraph Bot on Claude charted and summed up six months of revenue itself, and filled
 * in a web shop's order form itself, until the person told it to hand the work off. So the kinds of
 * work that go to a task are listed, the ask the person makes is never needed, and the line comes
 * before the call, which is the order the person reads them in.
 *
 * ONLY WHAT THE PERSON ASKED FOR. "Hand everything else to a task, without waiting to be asked to"
 * read as leave to start work: asked "are you able to build a sequence in Smartlead?", a Bot said
 * yes and started a task that read the person's campaigns, which nobody had asked for. So the work
 * handed off is the work the person asked for, and a question about whether the Bot can is named
 * as a short ask: an answer and an offer.
 *
 * THE LINE IS WHAT THE WORK TAKES, NOT HOW BIG IT LOOKS. "With no tools or one quick read" left the
 * size of an ask to the model's judgement, and Claude Sonnet 5.5 judged a chart of four figures
 * and a sheet with a total small enough to do itself, three runs of three each, while GPT-6.1
 * handed both off. So the line is drawn at the work itself: an app's tool, a computer, a search,
 * or something made for the person is a task's, however small.
 *
 * WHAT IS ABOUT THE CONVERSATION STAYS IN IT. Asked for a routine or a follow-up, a Bot handed that
 * to a task too. The routine then posted into the task's thread, which the person never opens, and
 * the follow-up was refused there. A routine, a follow-up and a goal belong to the conversation they
 * are asked for in, so the Bot sets them up in its own reply.
 *
 * MORE FOR A TASK GOES TO THAT TASK. "Tell it to also check the coat check" and "stop the Figma
 * one" are about a task already started, and the only tool a Bot had for work was `delegate`, which
 * starts another. `follow_up` and `stop` reach the task itself, and this names them for exactly
 * those asks, as the rest of this section names the work to hand off: a harness Bot reads its
 * tools' descriptions less closely than its instructions.
 *
 * A NEW DELIVERABLE IS A NEW TASK, "ALSO" OR NOT. While a task wrote a guide for EU customers, the
 * person asked "Also write a guide for US customers", and the Bot passed it to the EU task with
 * `follow_up`, reading "also" as more for that task. "Stop the EU one" could then only steer the
 * task writing both. Asked without "also" or "too", the same work became tasks of their own and
 * stopped one at a time. So what decides is whether the ask is another thing to make or do, not the
 * word it is asked with, and `follow_up` is named for changing or adding to the work a task does.
 *
 * ONLY THE TASK THEY MEAN. Measured live before this was said: the LangGraph Bot did the Figma
 * search itself instead of handing it off, and told "stop the Figma one" it stopped the only task
 * the conversation had, the venue's, in 2 of 3 runs. Stopping work the person still wants is worse
 * than stopping nothing, so a stop that names no task of this conversation stops nothing.
 *
 * NOTHING HERE ON HOW THE TASK REPORTS. Claude's briefs often end "report back with ... anything you
 * could not confirm", and the task's report is shaped after the brief instead (`BRIEF_CLOSE`). Told
 * here to end a brief at what to check, Claude wrote shorter briefs that dropped the work's own
 * checks: of 24 replayed briefs for "emails from the last day", 4 kept a rolling 24 hours (17 before),
 * and the task then took a 30-hour-old email as the last day's.
 *
 * THE TOOL IS NAMED WHERE IT IS CALLED, NOT AS WHAT THE BOT IS. This opened "When you hold
 * `delegate`, you are the person's point of contact", a condition the section already meets (it is
 * given only to a run that holds the tool) and a sentence a Bot can say back about itself. The
 * tools stay named in the sentences that say to call them.
 */
export const DELEGATING_GUIDANCE = [
  "You are the person's point of contact, and the work they ask for runs in task threads of your own, so this conversation stays short. Each turn, do exactly one of these three things, never two:",
  "- Answer directly only a short ask: a question you can answer in a few sentences from what you know or from this conversation, without a tool of an app, a computer or a search. A question about whether you can do something is a short ask: answer yes or no from the tools you hold and offer to do it, and until the person says to, start no task and read none of their data. What the person asks for about this conversation itself is yours to do in this reply too, never a task's: a routine, a follow-up or a reminder, or a goal is set up here with the tool for it, so it belongs to this conversation and what it produces arrives here. Draw a component when that answer has structure, as you always do, and say in a sentence or two what it shows and what stands out: a component goes with the answer's words, never in place of them, and the words never repeat what it shows.",
  `- React with ${REACT_TOOL} when the message needs only an acknowledgement, such as a thank-you or an 'ok': the reaction is your whole answer, so write nothing at all, not even the emoji. Never react to a message you answer or hand to a task.`,
  `- Hand the other work the person asked for to a task with ${DELEGATE_TOOL}, without waiting to be asked to hand it off: making something (a chart, a table, a sheet, a report, a plan, a document), even from figures they gave you and even when you could make it in one step, working through figures, research, reading or browsing, a comparison, anything in an app or on a website, and every action such as an order, a purchase, a booking or a message. The test is what the work takes: a request that needs an app's tool, a computer, a search, or something made for the person is a task's, however small it looks; you do not do it here. Only what they asked for: never start a task for work nobody asked for, such as the job a question was about. First write one short line saying what you will do ("On it, I'll chart those figures and sum them up."), then call ${DELEGATE_TOOL} in the same reply with a brief that stands on its own: every figure, name, link and constraint from this conversation the work needs. Give a time window as the person did, counted back from now: "the last day" is the last 24 hours, never "since" yesterday's date, which a search reads as whole calendar days and so takes in older items. Do not do the work yourself as well, and do not wait for it. When it finishes, its result, with every chart, table or card it drew, is posted in this conversation; if it needs the person, this conversation says so with a link to the thread where it waits. Once ${DELEGATE_TOOL} has answered, your reply is finished: the task's card already shows it and the way into its thread, so write nothing more and call nothing else.`,
  `When the person adds to or changes work a task of this conversation already has ("tell it to also check the parking", "it should use last year's figures", "ask it to add a chart"), pass it on with ${FOLLOW_UP_TOOL}, naming that task by the taskId its ${DELEGATE_TOOL} answer gave: that is the whole of your reply's work, so never start a new task for it and never do it yourself, even when the task has finished. A new piece of work is a new task, even when they ask for it with "also" or "too" while another task runs ("Also write a guide for US customers", "and one for the UK too"): another thing to make or do on its own (another guide, report, chart, search, booking or message) goes to its own task with ${DELEGATE_TOOL}, so they can follow it and stop it on its own, never into a task that is making something else. ${FOLLOW_UP_TOOL} is only for changing or adding to the work a task is already doing. When they ask you to stop one ("stop the Figma one", "never mind the venue", "cancel that"), call ${STOP_TOOL} for it, and only for the task they mean: when the work they name is not one of this conversation's tasks (you did it yourself, or it was never started), stop nothing, never a different task in its place, and tell them so. Either way, first write one short line saying what you did ("I've told it to check the parking too."), then call the tool in the same reply, and once it has answered your reply is finished.`,
  `Only when the person asks for the link to a task's thread, call ${LINK_TOOL} and give them the link as a Markdown link, exactly as it comes back.`,
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
  /**
   * Where it stands, in the words the Bot passes on (`taskStands`). Told `ready_for_review`, a Bot
   * said a finished task "may be waiting on you".
   */
  stands?: string;
  /** The path that opens it in the app. */
  link: string;
};

/** What `link_to_thread` answers. */
export type LinkResult = { threads: LinkedThread[] };

/**
 * What `follow_up` and `stop` answer when they reached the task, and what the conversation draws the
 * task's card from: the task, and for the model what happens next.
 */
export type TaskActionResult = {
  taskId: string;
  channelId: string;
  title: string;
  /** For `follow_up`: the message the task was sent, as its thread shows it. */
  message?: string;
  /** For the model: what happens next, so it neither waits nor does the work itself. */
  next: string;
};

/** The task, read back from a `follow_up` or `stop` result, or null for a refusal or anything else. */
export function readTaskActionResult(text: unknown): TaskActionResult | null {
  const result = parsedObject(text);
  if (
    !result ||
    typeof result.taskId !== "string" ||
    typeof result.channelId !== "string" ||
    typeof result.title !== "string"
  )
    return null;
  return result as TaskActionResult;
}

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

/** Where a task stands, by its status, in plain words for the model to pass on. */
export function taskStands(status: string): string {
  if (status === "ready_for_review" || status === "resolved")
    return "done: its result has been posted in this conversation";
  if (status === "needs_input") return "waiting for the person in its thread";
  if (status === "failed") return "could not finish";
  return "still working";
}

/** The path a task thread opens at in the app. */
export function threadPath(channelId: string): string {
  return `/channel/${channelId}`;
}

/**
 * What a task says in the conversation that asked for it.
 *
 * `result`: the work finished, and this is what it found. `needs`: it waits on the person, in its
 * own thread. `failed`: it ran out of tries. `steer`: the person typed into the task's thread when
 * it had asked for nothing, and these are their words (see `steerWords`).
 */
export type TaskReportKind = "result" | "needs" | "failed" | "steer";

/** The reports a conversation draws as a message of the task's. A steer is drawn under its card. */
export type DrawnTaskReportKind = Exclude<TaskReportKind, "steer">;

/** How much of what the person told a task its card quotes, in characters: one short line. */
export const STEER_MAX = 120;

/**
 * What the person told a task directly in its thread, as the one line under its card in the
 * conversation that asked quotes it: on one line, and cut at a word when it runs long.
 *
 * A steer is a message the person types in a task's thread when the task had not asked them for
 * anything. The conversation that started the task would otherwise never hear of it, and its card
 * would describe work the person has since changed. The words are theirs, so they are quoted, never
 * reworded.
 */
export function steerWords(said: string): string {
  const line = said.replace(/\s+/g, " ").trim();
  const letters = Array.from(line);
  if (letters.length <= STEER_MAX) return line;
  const head = letters.slice(0, STEER_MAX - 1).join("");
  // Cut at the last space when that keeps most of the line; a single long word is cut where it is.
  const space = head.lastIndexOf(" ");
  const kept = space > STEER_MAX / 2 ? head.slice(0, space) : head;
  return `${kept.replace(/[\s.,;:!?-]+$/, "")}…`;
}

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
  if (
    kind !== "result" &&
    kind !== "needs" &&
    kind !== "failed" &&
    kind !== "steer"
  )
    return null;
  if (!taskId) return null;
  return { kind, taskId };
}

/**
 * The words in front of the brief, in the task thread's first message.
 *
 * Addressed to the model doing the work: it is in a thread of its own, and what it says last is
 * what the person reads back in the conversation that asked, with any component it draws. So it is
 * asked to draw components as it would in that conversation, never to write plainer because the
 * work moved, and told what that last message is.
 *
 * THE REPORT IS THE RESULT, NOT THE WORKING. Told only to lead with the result, tasks came back with
 * an account of themselves: "I checked the full message thread", "I resolved the channel and
 * selected Alex Clarke because", 229 words for three facts. The person asked a question in one
 * conversation and the working is in another, which they can open; what comes back is the answer,
 * the size the question was.
 *
 * AND IT STANDS ON ITS OWN. Asked what changed in a contract, a task read the right email and
 * reported that "the substantive changes are clear" without saying them. The person reads the
 * conversation, not the task's thread, so the facts, figures and quotes they asked for are in the
 * report itself.
 *
 * THE WORDS STILL SAY IT WHEN A CARD SHOWS IT. With "say in words what it shows" gone from the
 * brief, a task drew a record card holding both contract changes and reported one line, "Source: I
 * checked Gmail". A component goes with the answer's words, as it does in a direct answer.
 *
 * A COMPONENT IS A STEP OF ITS OWN, BEFORE THE WORDS. "Your words first" had a model write its
 * summary and then the record card's call in the same message, as text: the card's JSON, after a
 * few stray characters, in the person's conversation. Called on its own before the answer, it is a
 * call. The conversation draws the words above it either way.
 *
 * NAMES, NOT IDS. A task that posted in Slack quoted its message back with the mention as Slack
 * stores it, `<@U0E2EALEX0>`.
 *
 * A REPORT OF WORK DONE IS SHAPED AFTER THE BRIEF (`BRIEF_CLOSE`). Claude Sonnet 5.5 reported a
 * three-app job (read the inbox, build a sheet, post in #sales) in 166 to 252 words, on OpenBot's own
 * runner and on the Claude Agent SDK alike, where GPT-5.6 Terra took 45 to 84: the sheet's rows
 * again, "I read the sheet back", what it left out and why, and each inference as a bullet. Claude
 * follows the brief, which comes last and often asks for "anything you could not confirm", over a
 * rule before it. Replayed on the real model: rules reworded here, 145 to 190 words; "under 60
 * words", 104 to 168; one paragraph of at most four sentences, no list, said after the brief, 81 to
 * 114 on the Claude Agent SDK. A question's answer is left as it was.
 */
const BRIEF_FRAME = [
  "This is a task from your conversation with the person, handed into a thread of its own so that conversation stays short. Do the work here with your tools, as you would there, and finish it.",
  "When the answer has structure (figures, a comparison, a list of items, a plan, a record), draw it with a component, as you always do: call the component in a step of its own, once the results it shows have come back and before you write your answer. Never write out what a component already shows: no Markdown table or list of the same rows beside it, and never a component's data as text.",
  "Your last message is your report. It alone is posted back in that conversation, with the components you drew; everything you say before it stays in this thread, where the person can open it. The person reads that conversation, not this thread, so the report must stand on its own: give the answer itself in words, with the facts, figures, dates and quotes they asked for, never only that you found them. A component goes with those words, never in place of them: when you drew one, say in a sentence or two what it shows and what stands out. Size it to the question: what you found, or what you did and its link, in a sentence or two when the ask was simple, then anything you could not confirm, a sentence each. Leave out how you got there: no account of what you searched, read, checked, resolved or chose, no list of steps, and no offer of more work.",
  "Write it to the person: never mention this brief, and never say where a component sits, such as 'the chart above'. Name people and channels the way the person would, never by an app's id or its markup for one.",
  "The task:",
];

/** The frame before a task's report was told to be the result alone, with a component drawn first. */
const WHOLE_ANSWER_FRAME = [
  BRIEF_FRAME[0],
  "Answer the way you always do: when the answer has structure (figures, a comparison, a list of items, a plan, a record), draw it with a component, and say in words what it shows and what stands out. Never write out what a component already shows: no Markdown table or list of the same rows beside it.",
  "Lead with the result and say plainly anything you could not confirm. Your answer and any components you draw are posted back in that conversation as they are, your words first; what you say while you work stays in this thread. Write it to the person: never mention this brief, and never say where a component sits, such as 'the chart above'.",
  "The task:",
];

/** The third line before a task's answer was asked not to name the brief or a component's place. */
const POSTED_BACK =
  "Lead with the result and say plainly anything you could not confirm. Your answer and any components you draw are posted back in that conversation as they are; what you say while you work stays in this thread.";

/**
 * Every frame a task's thread has opened with, newest first, so a thread opened under an earlier one
 * still reads as the Bot's brief. First the answer's opening sentences were all that came back; then
 * the answer came back whole; then a component's rows were no longer to be written out again beside
 * it; then the answer was asked not to name the brief ("not the 25.8% in the brief") or say a chart
 * was "above" when the conversation draws it below the words; then the report was asked to be the
 * result alone, standing on its own.
 */
const BRIEF_PREFIXES = [
  BRIEF_FRAME,
  WHOLE_ANSWER_FRAME,
  [
    WHOLE_ANSWER_FRAME[0],
    WHOLE_ANSWER_FRAME[1],
    POSTED_BACK,
    WHOLE_ANSWER_FRAME[3],
  ],
  [
    WHOLE_ANSWER_FRAME[0],
    "Answer the way you always do: when the answer has structure (figures, a comparison, a list of items, a plan, a record), draw it with a component rather than writing it out, and say in words what it shows and what stands out.",
    POSTED_BACK,
    WHOLE_ANSWER_FRAME[3],
  ],
  [
    WHOLE_ANSWER_FRAME[0],
    "Answer the way you always do: when the answer has structure (figures, a comparison, a list of items, a plan, a record), draw it with a component rather than writing it out.",
    "Begin your reply with one or two sentences that give the result and say plainly anything you could not confirm. Those sentences and any components you draw are posted back in that conversation; the rest stays in this thread.",
    ...WHOLE_ANSWER_FRAME.slice(3),
  ],
].map((frame) => [...frame, "", ""].join("\n"));

/**
 * What follows the brief: the shape of a report of work done, whatever the brief asked it to hold.
 * See `BRIEF_FRAME` on why it comes last. The example is on apps no test uses, and keeps one
 * inference, said to be one, because the claims rule is unchanged.
 */
export const BRIEF_CLOSE =
  "\n\nWhen the task above is to make, change or send something, your report is one paragraph of at most four sentences, with no list and no headings, whatever the task asks it to include: what you did, with its link, then at most one sentence on what the person should check, such as something you inferred rather than read. That sentence is where what you could not confirm goes, and nothing follows it. Leave out the items again, the checks you ran, what you read back and what you left out. Asked to find this week's invoices in email, save them to a Drive folder and tell the Finance channel, a whole report is: 'I saved this week's 4 invoices to [Invoices, week 46](link) and posted the list in #finance. Two vendor names come from their email addresses, so check those.'";

/** The brief, wrapped in the words that tell the turn it is a delegated task. */
export function frameBrief(brief: string): string {
  return `${BRIEF_PREFIXES[0]}${brief}${BRIEF_CLOSE}`;
}

/**
 * The brief back out of a framed message, or null if this was not one. See `readFiring`. A thread
 * opened before `BRIEF_CLOSE` was said has none to take off.
 */
export function readBrief(text: string): string | null {
  for (const prefix of BRIEF_PREFIXES)
    if (text.startsWith(prefix)) {
      const brief = text.slice(prefix.length);
      return brief.endsWith(BRIEF_CLOSE)
        ? brief.slice(0, -BRIEF_CLOSE.length)
        : brief;
    }
  return null;
}

/** How much of an answer a task posts back, in characters: an answer, not a report of the work. */
export const ANSWER_MAX = 8_000;

/**
 * What a task's answer says in the conversation that asked for it: the answer whole, as the work
 * gave it after its last step, so its summary, its tables and the line under a chart all come back
 * with the components it drew. An answer longer than `ANSWER_MAX` is cut at a paragraph, and says
 * the rest is in the thread.
 *
 * It used to be the opening sentence and any tables. A task that drew a chart and then said what it
 * showed came back as the chart and "Here's the chart", the summary dropped.
 */
export function resultForConversation(reply: string): string {
  const answer = reply.trim();
  if (Array.from(answer).length <= ANSWER_MAX) return answer;
  const paragraphs = answer.split(/\n\s*\n/);
  const kept: string[] = [];
  let length = 0;
  for (const paragraph of paragraphs) {
    const size = Array.from(paragraph).length + 2;
    if (length + size > ANSWER_MAX) break;
    kept.push(paragraph);
    length += size;
  }
  const head = kept.length
    ? kept.join("\n\n")
    : `${Array.from(answer).slice(0, ANSWER_MAX).join("").trimEnd()}…`;
  return `${head}\n\nThe rest is in the task's thread.`;
}
