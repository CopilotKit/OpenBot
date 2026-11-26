/**
 * What a Bot is writing right now, from the AG-UI events of a conversation's live socket (./live-thread.ts), as the
 * conversation screen draws it: "Working…" from the moment a run starts, then its words as they come, and the cards it
 * draws (gallery components, ./gallery) as their arguments stream in over TOOL_CALL_START, _ARGS and _END.
 *
 * Only a run in progress is held here. A run that has ended is in the conversation's messages, read over REST as
 * before; the screen reads them again when a run ends and then lets the run go ({@link settle}). Until then a run that
 * ended is still drawn, so its words never blink out between the two.
 */
import type {
  ConversationMessage,
  DrawnComponent,
} from "./api/generated/model";
import { type Answer, answerOf, drawable, isDrawn } from "./gallery/drawn";
import { partialArguments } from "./gallery/partial-json";
import type { LiveEvent } from "./live-thread";

type LiveMessage = { id: string; text: string };
/**
 * A gallery component the Bot is drawing: its tool call, the arguments as they have arrived so far (streamed JSON), and
 * the message it belongs to. Only a component the phone draws is held; any other tool call is left to the messages.
 */
type LiveTool = {
  id: string;
  name: string;
  args: string;
  messageId: string;
  /** TOOL_CALL_END came: its arguments are whole. */
  done: boolean;
  /** What the call answered (TOOL_CALL_RESULT), for a question the person was asked. */
  result?: string;
};
export type LiveRun = {
  id: string;
  ended: boolean;
  messages: LiveMessage[];
  tools: LiveTool[];
  /** RUN_ERROR's message: why the run failed, drawn as a failed reply until the messages hold it. */
  error?: string;
};
/** The runs being drawn, oldest first. */
export type LiveRuns = LiveRun[];

const runOf = (event: LiveEvent): string | undefined => {
  const id = event.runId ?? event.run_id;
  return typeof id === "string" && id ? id : undefined;
};
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;
const messageOf = (event: LiveEvent) => text(event.messageId);
const toolOf = (event: LiveEvent) => text(event.toolCallId);

/**
 * The run an event belongs to: the one it names, else the one holding its tool call or its message (or the message a
 * tool call is part of), else the newest.
 */
function find(runs: LiveRuns, event: LiveEvent): number {
  const named = runOf(event);
  if (named) return runs.findIndex((run) => run.id === named);
  const tool = toolOf(event);
  if (tool) {
    const holder = runs.findIndex((run) =>
      run.tools.some((item) => item.id === tool),
    );
    if (holder >= 0) return holder;
  }
  for (const message of [messageOf(event), text(event.parentMessageId)]) {
    if (!message) continue;
    const holder = runs.findIndex((run) =>
      run.messages.some((item) => item.id === message),
    );
    if (holder >= 0) return holder;
  }
  return runs.length - 1;
}

/** The run with one of its tool calls changed. A call it doesn't hold changes nothing. */
function withTool(
  runs: LiveRuns,
  event: LiveEvent,
  change: (tool: LiveTool) => LiveTool,
): LiveRuns {
  const id = toolOf(event);
  const at = find(runs, event);
  if (!id || at < 0) return runs;
  const run = runs[at] as LiveRun;
  if (!run.tools.some((tool) => tool.id === id)) return runs;
  return withRun(runs, at, (held) => ({
    ...held,
    tools: held.tools.map((tool) => (tool.id === id ? change(tool) : tool)),
  }));
}

/** A component the Bot started drawing, with the message it is part of: the one the event names, else its last. */
function started(runs: LiveRuns, event: LiveEvent): LiveRuns {
  const id = toolOf(event);
  const name = event.toolCallName;
  if (!id || !isDrawn(name)) return runs;
  const at = find(runs, event);
  if (at < 0) return runs;
  return withRun(runs, at, (run) => {
    if (run.tools.some((tool) => tool.id === id)) return run;
    const parent =
      text(event.parentMessageId) ?? run.messages.at(-1)?.id ?? `tools:${id}`;
    const messages = run.messages.some((item) => item.id === parent)
      ? run.messages
      : [...run.messages, { id: parent, text: "" }];
    return {
      ...run,
      messages,
      tools: [
        ...run.tools,
        { id, name, args: "", messageId: parent, done: false },
      ],
    };
  });
}

function withRun(
  runs: LiveRuns,
  index: number,
  change: (run: LiveRun) => LiveRun,
): LiveRuns {
  return runs.map((run, at) => (at === index ? change(run) : run));
}

/** The runs after one more event. Events of a type it doesn't know change nothing. */
export function reduce(runs: LiveRuns, event: LiveEvent): LiveRuns {
  switch (event.type) {
    case "RUN_STARTED": {
      const id = runOf(event);
      if (!id || runs.some((run) => run.id === id)) return runs;
      return [...runs, { id, ended: false, messages: [], tools: [] }];
    }
    case "RUN_FINISHED":
    case "RUN_ERROR": {
      const at = find(runs, event);
      const error =
        event.type === "RUN_ERROR"
          ? (text(event.message)?.trim() ??
            "This reply stopped before it finished.")
          : undefined;
      return at < 0
        ? runs
        : withRun(runs, at, (run) => ({
            ...run,
            ended: true,
            ...(error ? { error } : {}),
          }));
    }
    case "TEXT_MESSAGE_START":
    case "TEXT_MESSAGE_CONTENT":
    case "TEXT_MESSAGE_CHUNK": {
      // A reply's words only: reasoning comes as events of its own, and a person's message is already drawn.
      if (typeof event.role === "string" && event.role !== "assistant")
        return runs;
      const id = messageOf(event);
      const at = find(runs, event);
      if (!id || at < 0) return runs;
      const delta = typeof event.delta === "string" ? event.delta : "";
      return withRun(runs, at, (run) => {
        const held = run.messages.some((item) => item.id === id);
        if (!held)
          return { ...run, messages: [...run.messages, { id, text: delta }] };
        if (!delta) return run;
        return {
          ...run,
          messages: run.messages.map((item) =>
            item.id === id ? { ...item, text: item.text + delta } : item,
          ),
        };
      });
    }
    case "TOOL_CALL_START":
      return started(runs, event);
    case "TOOL_CALL_CHUNK": {
      // A chunk stands for START, ARGS and END in one: the first one of a call names it.
      const begun = started(runs, event);
      const delta = typeof event.delta === "string" ? event.delta : "";
      return delta
        ? withTool(begun, event, (tool) => ({
            ...tool,
            args: tool.args + delta,
          }))
        : begun;
    }
    case "TOOL_CALL_ARGS": {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (!delta) return runs;
      return withTool(runs, event, (tool) => ({
        ...tool,
        args: tool.args + delta,
      }));
    }
    case "TOOL_CALL_END":
      return withTool(runs, event, (tool) => ({ ...tool, done: true }));
    case "TOOL_CALL_RESULT": {
      const content = event.content;
      if (typeof content !== "string") return runs;
      return withTool(runs, event, (tool) => ({ ...tool, result: content }));
    }
    default:
      return runs;
  }
}

/** A live component as a message carries it, once what has arrived of its arguments reads as an object. */
function drawnNow(tool: LiveTool): DrawnComponent | undefined {
  const args =
    tool.done && !tool.args.trim() ? {} : partialArguments(tool.args);
  return args
    ? { toolCallId: tool.id, name: tool.name, arguments: args }
    : undefined;
}

/** The tool calls whose arguments may still be arriving: a card drawn from them holds what is half written. */
export function arriving(runs: LiveRuns): Set<string> {
  const out = new Set<string>();
  for (const run of runs) {
    if (run.ended) continue;
    for (const tool of run.tools) if (!tool.done) out.add(tool.id);
  }
  return out;
}

/** What the person answered the questions a live run asked, by tool call. */
export function liveAnswers(runs: LiveRuns): Map<string, Answer> {
  const out = new Map<string, Answer>();
  for (const run of runs)
    for (const tool of run.tools) {
      const answer = answerOf(tool.result);
      if (answer) out.set(tool.id, answer);
    }
  return out;
}

/**
 * What Stop does now. Offered only where the server says runStop, in a conversation with one Bot (the server keeps no
 * run record for a group, and answers 404 for any of its runs), while a run is live here: the runs it stops, every live
 * one, less those already asked to stop. `stopping` is every live run asked already, ending on the server: the button
 * waits.
 */
export function stopOffer(
  runs: LiveRuns,
  where: { runStop: boolean; group: boolean },
  asked: ReadonlySet<string>,
): { runs: string[]; stopping: boolean } | null {
  if (!where.runStop || where.group) return null;
  const live = runs.filter((run) => !run.ended).map((run) => run.id);
  if (live.length === 0) return null;
  const left = live.filter((id) => !asked.has(id));
  return { runs: left, stopping: left.length === 0 };
}

/** What the thread replayed when the socket joined, down to the runs still in progress: an ended one is in the messages. */
export function caughtUp(runs: LiveRuns): LiveRuns {
  return runs.filter((run) => !run.ended);
}

/** The runs after the messages were read again: an ended run is in them now, and goes. */
export function settle(runs: LiveRuns): LiveRuns {
  // A run that failed stays, as its failure: the messages may not hold one (asMessages leaves it out if they do).
  return runs.filter((run) => !run.ended || run.error);
}

/** The runs once the person sends again: a failure they have seen goes, so it isn't drawn after what they sent. */
export function sentAgain(runs: LiveRuns): LiveRuns {
  return runs.filter((run) => !run.ended);
}

/**
 * The runs as messages, newest first as the API lists them, for the screen to put in front of the ones it read. A run
 * with no words yet is one Bot reply at work, which the screen draws as "Working…". Words the read messages already hold
 * (the same id, or a finished reply saying the same) are left out, so a reply is never drawn twice. A message carries
 * the components the Bot is drawing in it (`components`), less any a read message already has by its tool call: those
 * are drawn there. Still held there are the ones the read message lacks, on a message of their own.
 */
export function asMessages(
  runs: LiveRuns,
  read: readonly ConversationMessage[],
): ConversationMessage[] {
  const ids = new Set(read.map((message) => message.id));
  const said = new Set(
    read
      .filter((message) => message.role === "bot" && message.text)
      .map((message) => message.text.trim()),
  );
  const drawn = new Set(
    read.flatMap((message) =>
      drawable(message).map((component) => component.toolCallId),
    ),
  );
  const failedHere = new Set(
    read
      .filter(
        (message) => message.role === "bot" && message.status === "failed",
      )
      .map((message) => message.id),
  );
  const out: ConversationMessage[] = [];
  for (const run of runs) {
    const reply = (
      id: string,
      text: string,
      components: DrawnComponent[],
    ): ConversationMessage => ({
      id,
      role: "bot",
      personId: null,
      botId: null,
      text,
      status: run.ended ? "completed" : "running",
      createdAt: null,
      ...(components.length ? { components } : {}),
    });
    const shown: ConversationMessage[] = [];
    for (const item of run.messages) {
      const components = run.tools
        .filter((tool) => tool.messageId === item.id && !drawn.has(tool.id))
        .flatMap((tool) => drawnNow(tool) ?? []);
      // A reply still being written is never taken for an older one that says the same so far.
      const held =
        ids.has(item.id) ||
        (run.ended && Boolean(item.text) && said.has(item.text.trim()));
      if (!held && (item.text || !run.ended || components.length))
        shown.push(reply(item.id, item.text, components));
      else if (held && components.length)
        shown.push(reply(`${item.id}:components`, "", components));
    }
    // A run that failed says why, as a failed reply, unless the messages read back already do.
    if (
      run.error &&
      !said.has(run.error) &&
      !run.messages.some((item) => failedHere.has(item.id))
    )
      shown.push({
        ...reply(`error:${run.id}`, run.error, []),
        status: "failed",
      });
    if (shown.length === 0) {
      if (!run.ended && run.messages.length === 0)
        out.push(reply(`run:${run.id}`, "", []));
      continue;
    }
    out.push(...shown);
  }
  return out.reverse();
}
