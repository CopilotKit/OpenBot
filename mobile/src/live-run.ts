/**
 * What a Bot is writing right now, from the AG-UI events of a conversation's live socket (./live-thread.ts), as the
 * conversation screen draws it: "Working…" from the moment a run starts, then its words as they come.
 *
 * Only a run in progress is held here. A run that has ended is in the conversation's messages, read over REST as
 * before; the screen reads them again when a run ends and then lets the run go ({@link settle}). Until then a run that
 * ended is still drawn, so its words never blink out between the two.
 */
import type { ConversationMessage } from "./api/generated/model";
import type { LiveEvent } from "./live-thread";

type LiveMessage = { id: string; text: string };
export type LiveRun = { id: string; ended: boolean; messages: LiveMessage[] };
/** The runs being drawn, oldest first. */
export type LiveRuns = LiveRun[];

const runOf = (event: LiveEvent): string | undefined => {
  const id = event.runId ?? event.run_id;
  return typeof id === "string" && id ? id : undefined;
};
const messageOf = (event: LiveEvent): string | undefined =>
  typeof event.messageId === "string" && event.messageId
    ? event.messageId
    : undefined;

/** The run an event belongs to: the one it names, else the one holding its message, else the newest. */
function find(runs: LiveRuns, event: LiveEvent): number {
  const named = runOf(event);
  if (named) return runs.findIndex((run) => run.id === named);
  const message = messageOf(event);
  if (message) {
    const holder = runs.findIndex((run) =>
      run.messages.some((item) => item.id === message),
    );
    if (holder >= 0) return holder;
  }
  return runs.length - 1;
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
      return [...runs, { id, ended: false, messages: [] }];
    }
    case "RUN_FINISHED":
    case "RUN_ERROR": {
      const at = find(runs, event);
      return at < 0
        ? runs
        : withRun(runs, at, (run) => ({ ...run, ended: true }));
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
    default:
      return runs;
  }
}

/** What the thread replayed when the socket joined, down to the runs still in progress: an ended one is in the messages. */
export function caughtUp(runs: LiveRuns): LiveRuns {
  return runs.filter((run) => !run.ended);
}

/** The runs after the messages were read again: an ended run is in them now, and goes. */
export function settle(runs: LiveRuns): LiveRuns {
  return runs.filter((run) => !run.ended);
}

/**
 * The runs as messages, newest first as the API lists them, for the screen to put in front of the ones it read. A run
 * with no words yet is one Bot reply at work, which the screen draws as "Working…". Words the read messages already hold
 * (the same id, or a finished reply saying the same) are left out, so a reply is never drawn twice.
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
  const out: ConversationMessage[] = [];
  for (const run of runs) {
    // A reply still being written is never taken for an older one that says the same so far.
    const shown = run.messages.filter(
      (item) =>
        !ids.has(item.id) &&
        !(run.ended && (!item.text || said.has(item.text.trim()))),
    );
    if (run.ended && shown.length === 0) continue;
    const reply = (id: string, text: string): ConversationMessage => ({
      id,
      role: "bot",
      personId: null,
      botId: null,
      text,
      status: run.ended ? "completed" : "running",
      createdAt: null,
    });
    if (shown.length === 0) {
      if (run.messages.length === 0) out.push(reply(`run:${run.id}`, ""));
      continue;
    }
    for (const item of shown) out.push(reply(item.id, item.text));
  }
  return out.reverse();
}
