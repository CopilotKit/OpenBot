import { SUBAGENT_TOOL } from "@openbot/shared/subagent";
import {
  asksThePerson,
  type TranscriptItem,
} from "@/components/channels/tool-activity";
import { isPersonSentMessage } from "@/components/channels/transcript-turns";
import { claudeCodeCall } from "@/lib/copilot/coding-calls";

/*
 * A task's thread, read the way dots reads one: what it was asked, one "Worked for 2m" row, and
 * what it came back with. The steps it took and the lines it said on the way fold into that row,
 * which opens to them.
 *
 * Only work folds: a run of tool lines (`tools`), a step the app draws as a card of its own (a
 * command it ran, a file it changed, a page it opened on its computer, a subtask), and what the Bot
 * said before its answer. What is drawn for the person (a chart, a table, an app's card, a
 * question, a request for help, an approval still waiting) stays where it is, because it is either
 * part of the answer or something the person has to act on, and neither may sit behind a
 * disclosure. A turn still running keeps its newest line out, since it may be the answer arriving.
 */

/** One turn's work, folded: where it is drawn, what it answered, and the rows inside it. */
export type TurnWork = {
  /** The row's own key: `work:` and the first folded row's id, kept for the turn's whole life. */
  id: string;
  /** The person's message (or the Bot's brief) the turn answered, as the thread names it. */
  askId: string;
  /** The rows it holds, in order, each with its place among the transcript's items. */
  rows: { item: TranscriptItem; index: number }[];
  /** The turn is still under way. */
  running: boolean;
};

export type TurnWorkFolds = {
  /** Each fold, by the id of the first row it holds, which is where it is drawn. */
  at: Map<string, TurnWork>;
  /** Every row inside a fold, drawn there and not on its own. */
  inside: Set<string>;
};

/** No folds: a thread that is not a task's. */
export const NO_TURN_WORK: TurnWorkFolds = { at: new Map(), inside: new Set() };

/**
 * Whether a call drawn on its own is a step of the work: Claude Code's own tools, the Bot computer's
 * (but not its requests to the person), an app's call, a subtask. Finished, and asking nothing.
 */
function isWorkStep(item: Extract<TranscriptItem, { kind: "tool" }>): boolean {
  if (item.result === undefined || asksThePerson(item.result)) return false;
  const { name, arguments: args } = item.toolCall.function;
  if (name.startsWith("mcp__") || name === SUBAGENT_TOOL) return true;
  if (name.startsWith("computer_"))
    return !name.startsWith("computer_request_");
  return claudeCodeCall(name, args);
}

/**
 * Whether a run of tool lines still waits on the person: a step held for their approval (`waiting`,
 * the approval inbox's open requests by tool call; its card is drawn under the run's line), a step
 * with no answer in a turn that is over, and a step whose answer asks them to connect or consent.
 * Any of these stays out of the fold, card and all. FOUND BY THE APPROVALS JOURNEYS: a payment's
 * approval card folded into "Worked for 5s", so the thread showed nothing to answer, in a task's
 * turn and in a turn the person typed into the thread alike.
 */
function waitsOnThePerson(
  item: Extract<TranscriptItem, { kind: "tools" }>,
  inFlight: boolean,
  waiting: ReadonlySet<string>,
): boolean {
  return item.steps.some(
    (step) =>
      waiting.has(step.toolCall.id) ||
      (step.result === undefined && !inFlight) ||
      asksThePerson(step.result),
  );
}

function isPersons(item: TranscriptItem): boolean {
  return (
    (item.kind === "text" && isPersonSentMessage(item.role, item.text)) ||
    item.kind === "attachments"
  );
}

/**
 * The folds of a task thread's turns. `running` says the last turn is still under way: the person's
 * browser is streaming it, or the task reads Working. `waiting` is the tool calls held for the
 * person's approval (`useWaitingToolCalls`).
 */
export function foldTurnWork(
  items: readonly TranscriptItem[],
  running: boolean,
  waiting: ReadonlySet<string> = new Set(),
): TurnWorkFolds {
  const folds: TurnWorkFolds = { at: new Map(), inside: new Set() };
  // Where each turn starts: just after what the person (or the brief) said.
  const starts: { askId: string; at: number; from: number }[] = [];
  items.forEach((item, index) => {
    if (!isPersons(item)) return;
    const previous = starts.at(-1);
    // A caption and its files are one ask: the turn answers the text, when there is text.
    if (previous && previous.from === index) {
      if (item.kind === "text") previous.askId = item.id;
      previous.from = index + 1;
      return;
    }
    starts.push({ askId: item.id, at: index, from: index + 1 });
  });
  starts.forEach((start, turn) => {
    const end = starts[turn + 1]?.at ?? items.length;
    const inFlight = running && turn === starts.length - 1;
    const said: number[] = [];
    for (let index = start.from; index < end; index += 1) {
      const item = items[index];
      if (item?.kind === "text" && item.role === "assistant") said.push(index);
    }
    // What it came back with: its last line, once the turn is over; while it runs, the newest line
    // only when it is the newest row, since that may be the answer arriving.
    const answer = inFlight
      ? said.at(-1) === end - 1
        ? end - 1
        : -1
      : (said.at(-1) ?? -1);
    const rows: TurnWork["rows"] = [];
    for (let index = start.from; index < end; index += 1) {
      const item = items[index];
      if (!item || index === answer) continue;
      if (
        (item.kind === "tools" && !waitsOnThePerson(item, inFlight, waiting)) ||
        (item.kind === "tool" && isWorkStep(item)) ||
        (item.kind === "text" && item.role === "assistant")
      )
        rows.push({ item, index });
    }
    const first = rows[0];
    if (!first) return;
    const work: TurnWork = {
      id: `work:${first.item.id}`,
      askId: start.askId,
      rows,
      running: inFlight,
    };
    folds.at.set(first.item.id, work);
    for (const row of rows) folds.inside.add(row.item.id);
  });
  return folds.at.size ? folds : NO_TURN_WORK;
}

/** How many steps a fold holds: each tool call in it, a run of them counted call by call. */
export function stepsIn(work: TurnWork): number {
  return work.rows.reduce(
    (count, { item }) =>
      count +
      (item.kind === "tools"
        ? item.steps.length
        : item.kind === "tool"
          ? 1
          : 0),
    0,
  );
}
