import {
  DECLINED_BY_PERSON,
  declinedByPerson,
  doneByPerson,
  outcomeForPerson,
} from "@openbot/shared/approval-outcomes";
import type { Message } from "@ag-ui/core";
import { useCopilotKit } from "@copilotkit/react-core/v2";
import { useEffect } from "react";
import type { ToolOutcome } from "./call";

/**
 * What a Bot has been doing on its computer, other than browsing.
 *
 * The screen answers "what is it looking at" and nothing answered "what is it doing". A shell
 * command rendered in the transcript as one grey line, `Ran a command  rg --version`, with the output
 * nowhere: the model saw it, decided which part mattered, and the person watching had to take its
 * word. The same was true of reading a file and listing a folder. That is a poor deal on a machine
 * holding somebody's logins, and it is the thing an operator asks about first.
 *
 * READ FROM THE CONVERSATION, NOT WRITTEN BY THE TOOL HANDLERS. It used to be written by the browser's
 * handlers as each call came back, and since the approval gate most calls never come back through
 * them: a command, a keystroke or a saved file is sent to the server's gate, which runs it and
 * answers, or holds it for a person and runs it once they allow it, continuing the conversation
 * itself. The pane sat on "Nothing yet" while a Bot ran command after command. Whichever way a call
 * ran (the browser, the gate at once, the gate after a decision), its answer ends up in the
 * conversation as the tool's result, and that is where this reads it. A conversation opened again
 * after a reload is read the same way, so the pane shows what was done in it.
 *
 * ONE ENTRY PER TOOL CALL. The conversation is read again every time it changes and every time it is
 * opened, so an entry is keyed by the call it came from, and reading it twice changes nothing.
 *
 * Still a view, not the record. The audit trail on the server is what an investigation reads; this is
 * the pane beside the screen, kept in the page. Keeping it there means no new endpoint, no polling,
 * and no second copy of command output in the database.
 */

/** One thing a Bot did on its computer. */
export type ComputerActivity = {
  /** The tool call it was. A call read again is this same entry, never a second one. */
  id: string;
  /**
   * When it finished, for the timestamp beside it. Only for a call this page watched: one it started
   * running, or one the person answered here. One already done when its conversation was opened says
   * what was done, not when: the time the page read it would be a guess drawn as a fact.
   */
  at?: number;
  kind: "command" | "read_file" | "write_file" | "list_files";
  /** The command, or the path. What the line says it acted on. */
  subject: string;
  /** What came back. Empty when a command printed nothing, which is worth showing as itself. */
  output: string;
  /** Present for a command. Non-zero is drawn as a failure. */
  exitCode?: number;
  /** A boundary refused it, or it was not carried out. Drawn differently from a command that ran and failed. */
  refused?: boolean;
  /** Refused because the person declined it, so the line says declined rather than what it would have done. */
  declined?: boolean;
  /**
   * It was handed to the person and they did it themselves. Done, so not drawn as refused, and
   * nothing ran on the computer for it, so not drawn as a command that printed nothing either.
   */
  doneByPerson?: boolean;
  /** The far side cut the output short, or stopped the command. Said out loud rather than implied. */
  truncated?: boolean;
  timedOut?: boolean;
};

/** What a call did, without the bookkeeping the pane adds to it. */
export type ActivityDetails = Omit<ComputerActivity, "id" | "at">;

/** One computer call in a conversation: what it did, or null while it waits for its answer. */
export type ConversationCall = { id: string; did: ActivityDetails | null };

/**
 * The most recent entries per computer.
 *
 * Bounded, because a Bot working through a large job runs a lot of commands and this is a pane, not
 * an archive. The oldest go first: what somebody watching wants is what just happened.
 */
const LIMIT = 200;

const byComputer = new Map<string, ComputerActivity[]>();
/**
 * Every call a computer's pane has taken in, including the ones it has since let go: aged out past
 * the limit, or wiped with the computer. The conversation is read again on every change, and those
 * must stay gone rather than come back on the next read.
 */
const taken = new Map<string, Set<string>>();
/**
 * The last wipe of each computer, kept in `localStorage` as well as here.
 *
 * Kept in the page alone, a wipe lasted until the next reload: the conversation still holds every
 * call the deleted machine ran, and a page opened afresh, or another tab, read them all back. Kept
 * where every page on this browser reads it, a wiped call stays gone wherever the conversation opens.
 *
 * The server knows a wipe only as a row in the audit trail, which a member's page cannot read, and
 * a conversation's calls carry no time to compare one against. So a wipe is kept as what this
 * browser can say about it: when it happened, the calls the wiping page had read (they and
 * everything before them in their conversation ran on the wiped machine), and the calls a page here
 * watched run after it (they and everything after them ran on the new one).
 *
 * NOT ONLY THE CALLS THE WIPING PAGE HAD READ. That was all a wipe kept, and the page that wipes is
 * Admin, which reads no conversation: opened on its own, it had read nothing, kept nothing, and a
 * reload brought every command from the deleted machine back. A conversation with neither kind of
 * call in it is now from before the wipe, all of it, until a page here watches a call run in it.
 */
type Wipe = {
  /** When, by this browser's clock. Absent for one kept before wipes had a time. */
  at?: number;
  before: Set<string>;
  after: Set<string>;
};
const wipes = new Map<string, Wipe | null>();
const WIPED = "openbot:computer-activity-wiped:";
/** How many calls a wipe keeps of each kind. Only the latest before it and the first after it in each conversation are needed. */
const WIPED_KEPT = 1000;
/**
 * Calls this page watched, so their answer can say when it came: ones this page started running,
 * and ones the person answered here.
 *
 * NOT CALLS IT SAW WAITING FOR AN ANSWER. Opening a conversation replays it run by run, and a call's
 * answer arrives with the next run, so between the two every call in the history waits for an
 * answer for a moment. A render that caught one there took the history as live work, and the entry
 * was stamped with the time the page was loaded, a different one on each reload.
 */
const asked = new Set<string>();
const listeners = new Set<() => void>();

/** A stable empty array, so `useSyncExternalStore` does not see a new value on every render. */
const NONE: ComputerActivity[] = [];

function notify(): void {
  for (const listener of listeners) listener();
}

function sameDetails(entry: ComputerActivity, details: ActivityDetails) {
  return (
    entry.kind === details.kind &&
    entry.subject === details.subject &&
    entry.output === details.output &&
    entry.exitCode === details.exitCode &&
    entry.refused === details.refused &&
    entry.declined === details.declined &&
    entry.doneByPerson === details.doneByPerson &&
    entry.truncated === details.truncated &&
    entry.timedOut === details.timedOut
  );
}

function idsIn(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];
}

/** A wipe as `localStorage` holds it, or null when there is none to read. */
function wipeIn(text: string | null | undefined): Wipe | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // The first shape a wipe was kept in: the calls it took, and no time.
  if (Array.isArray(parsed))
    return { before: new Set(idsIn(parsed)), after: new Set() };
  if (!parsed || typeof parsed !== "object") return null;
  const { at, before, after } = parsed as Record<string, unknown>;
  return {
    ...(typeof at === "number" ? { at } : {}),
    before: new Set(idsIn(before)),
    after: new Set(idsIn(after)),
  };
}

/** This computer's last wipe, read from `localStorage` the first time it is asked for. */
function wipeOf(computerId: string): Wipe | null {
  const known = wipes.get(computerId);
  if (known !== undefined) return known;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(WIPED + computerId);
  } catch {
    // A browser that refuses storage (a private window, a policy) still keeps the wipe for this page.
  }
  const wipe = wipeIn(stored);
  wipes.set(computerId, wipe);
  return wipe;
}

function keepWipe(computerId: string, wipe: Wipe): void {
  wipes.set(computerId, wipe);
  try {
    window.localStorage.setItem(
      WIPED + computerId,
      JSON.stringify({
        ...(wipe.at === undefined ? {} : { at: wipe.at }),
        before: [...wipe.before].slice(-WIPED_KEPT),
        after: [...wipe.after].slice(-WIPED_KEPT),
      }),
    );
  } catch {
    // Kept for this page all the same: see `wipeOf`.
  }
}

/*
 * Another tab wiping a computer drops what this one shows of it too. The browser tells every other
 * page on this origin when `localStorage` changes, never the page that changed it. A change that is
 * the same wipe (another tab noting a call it watched run after it) only adds what it learnt.
 */
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (!event.key?.startsWith(WIPED)) return;
    const computerId = event.key.slice(WIPED.length);
    const wipe = wipeIn(event.newValue);
    if (!wipe) return;
    // What this page knew, not what storage holds now: that is already the new value.
    const previous = wipes.get(computerId);
    wipes.set(computerId, wipe);
    if (previous && previous.at === wipe.at) {
      for (const id of previous.before) wipe.before.add(id);
      for (const id of previous.after) wipe.after.add(id);
      return;
    }
    const current = byComputer.get(computerId);
    if (!current) return;
    const kept = current.filter((entry) =>
      wipe.at === undefined
        ? !wipe.before.has(entry.id)
        : entry.at !== undefined && entry.at >= wipe.at,
    );
    if (kept.length === current.length) return;
    byComputer.set(computerId, kept);
    notify();
  });

/**
 * Where a conversation's calls from after the wipe begin: after the last one the wiping page had
 * read, or at the first one a page here watched run after it. Null when the conversation says
 * neither, and then only a call this page watches is from after it.
 */
function afterWipe(
  calls: readonly ConversationCall[],
  wipe: Wipe | null,
): number | null {
  if (!wipe) return 0;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call && wipe.before.has(call.id)) return index + 1;
  }
  const first = calls.findIndex((call) => wipe.after.has(call.id));
  if (first !== -1) return first;
  return wipe.at === undefined ? 0 : null;
}

/**
 * Take in one conversation's computer calls, in the order they were made.
 *
 * A call already here is updated in place, never added twice: its answer is read again on every
 * change, and can arrive twice (the browser's placeholder while a person decides, then the server's
 * real answer beside it). A call new to the pane goes in just before the next of the conversation's
 * calls already here. So a conversation whose earlier history is read after its latest turns, which
 * is how a stored thread merges in, still lists in the order things ran; and a call with nothing after
 * it, which is what live work is, goes at the end.
 */
export function recordActivity(
  computerId: string,
  calls: readonly ConversationCall[],
): void {
  const current = byComputer.get(computerId) ?? NONE;
  const had = taken.get(computerId) ?? new Set<string>();
  const present = new Map(current.map((entry) => [entry.id, entry]));
  const wipe = wipeOf(computerId);
  // Where this conversation's calls from after the last wipe begin, if it can be told.
  const since = afterWipe(calls, wipe);
  let next: ComputerActivity[] | null = null;
  let watchedSinceWipe = false;
  // The nearest later call of this conversation that the pane holds, which a new one goes before.
  let after: string | undefined;
  for (let index = calls.length - 1; index >= (since ?? 0); index -= 1) {
    const call = calls[index];
    if (!call?.did) continue;
    const existing = present.get(call.id);
    if (existing) {
      if (!sameDetails(existing, call.did)) {
        next ??= [...current];
        const position = next.findIndex((entry) => entry.id === call.id);
        next[position] = {
          ...call.did,
          id: call.id,
          ...(existing.at === undefined ? {} : { at: existing.at }),
        };
      }
      after = call.id;
      continue;
    }
    // Wiped, or aged out past the limit.
    if (had.has(call.id)) continue;
    // A conversation that cannot place the wipe: only what this page watched is from after it.
    if (since === null && !asked.has(call.id)) continue;
    next ??= [...current];
    const at = asked.delete(call.id) ? Date.now() : undefined;
    const entry: ComputerActivity = {
      ...call.did,
      id: call.id,
      ...(at === undefined ? {} : { at }),
    };
    const before =
      after === undefined
        ? -1
        : next.findIndex((candidate) => candidate.id === after);
    next.splice(before === -1 ? next.length : before, 0, entry);
    had.add(call.id);
    after = call.id;
    // Watched after the wipe, so it places the wipe in its conversation for every page from now on.
    if (wipe?.at !== undefined && at !== undefined && at >= wipe.at) {
      wipe.after.add(call.id);
      watchedSinceWipe = true;
    }
  }
  if (wipe && watchedSinceWipe) keepWipe(computerId, wipe);
  if (!next) return;
  taken.set(computerId, had);
  byComputer.set(computerId, next.slice(-LIMIT));
  notify();
}

/**
 * A call this page watched: it started running here, or the person answered it here, which a step
 * held for them before a reload is. Its answer comes once it has run, so its entry says when.
 */
export function noteWatched(toolCallId: string): void {
  asked.add(toolCallId);
}

export function activityFor(computerId: string): ComputerActivity[] {
  return byComputer.get(computerId) ?? NONE;
}

/** The four calls that act on the computer behind the screen, and what the pane calls each. */
const KINDS: Record<string, ComputerActivity["kind"]> = {
  computer_run_command: "command",
  computer_read_file: "read_file",
  computer_write_file: "write_file",
  computer_list_files: "list_files",
};

/** CopilotKit's stand-in for a frontend tool's answer that has not been given yet. */
const FORWARDED_TO_CLIENT = "Forwarded to client";

/**
 * A computer call's result, as the transcript's line and the Activity pane both read it, or null
 * when it is not one yet.
 *
 * Three shapes reach a computer call's result. The computer's own answer, as JSON: from the
 * browser's handler, or the gate's `{ result }`, or the server's continuation after a decision, which
 * stores the same object. A placeholder while the answer is on its way: `{ waiting: true }`, which
 * the browser's handler returns when the gate holds the step for a person, and CopilotKit's own. And
 * a sentence instead of an answer: the server's, for a step the Bot did not carry out (declined,
 * refused when it was checked again, its outcome unknown, or done by the person themselves), or the
 * SDK's `Error: <message>` for a handler that threw. A sentence is drawn as not done, with the
 * sentence as its reason, because a step that did not run must never be drawn as one that ran and
 * printed nothing. The one exception is the person having done it: that was done, so it is read as
 * done, by them, and still with its sentence.
 *
 * One reader for both, because two drifted: the transcript read a sentence as an empty success, and
 * said "It printed nothing" about a command the person had just declined, beside a pane that said so.
 */
export function readOutcome(content: unknown): ToolOutcome | null {
  if (typeof content !== "string") return null;
  const text = content.trim();
  if (!text || text === FORWARDED_TO_CLIENT) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const outcome = parsed as Record<string, unknown>;
    if (outcome.waiting === true) return null;
    return { ...outcome, ok: outcome.ok !== false };
  }
  if (doneByPerson(text)) return { ok: true, doneByPerson: true, reason: text };
  if (declinedByPerson(text))
    return { ok: false, refused: true, declined: true, reason: text };
  return text.startsWith("Error:")
    ? { ok: false, reason: text.slice("Error:".length).trim() }
    : { ok: false, refused: true, reason: text };
}

/**
 * Remember a value in a cache that keeps its most recent entries only. Long enough for every
 * computer call of the conversations a person has open; short of holding a session's output for ever.
 */
const CACHED = 1000;
function remember<V>(cache: Map<string, V>, key: string, value: V): V {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}

/**
 * Each answer parsed once, and each call's arguments too: a file save's carry the whole file.
 *
 * A conversation is read on every change, which while a reply streams is every word of it, and the
 * SDK hands over a fresh copy of every message each time (`structuredClone` in `@ag-ui/client`), so
 * nothing can be remembered by the message object. Kept by id instead: the tool message's for an
 * answer, the call's for what it did. An id with new content (an answer the SDK fills in, arguments
 * still streaming) is read again.
 */
const answers = new Map<
  string,
  { content: unknown; outcome: ToolOutcome | null }
>();
const done = new Map<
  string,
  { args: string; answer: ToolOutcome; did: ActivityDetails }
>();

function answerOf(message: {
  id: string;
  content?: unknown;
}): ToolOutcome | null {
  const known = answers.get(message.id);
  if (known && known.content === message.content) return known.outcome;
  return remember(answers, message.id, {
    content: message.content,
    outcome: readOutcome(message.content),
  }).outcome;
}

function didOf(
  kind: ComputerActivity["kind"],
  call: { id: string; function: { arguments: string } },
  answer: ToolOutcome,
): ActivityDetails {
  const known = done.get(call.id);
  if (
    known &&
    known.answer === answer &&
    known.args === call.function.arguments
  )
    return known.did;
  return remember(done, call.id, {
    args: call.function.arguments,
    answer,
    did: detailsOf(kind, argumentsOf(call.function.arguments), answer),
  }).did;
}

function argumentsOf(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * What a call printed, as text a person can read.
 *
 * One helper because the three surfaces this feeds all want the same thing and shape it differently:
 * a command has `stdout` and `stderr`, a file read has `text`, a listing has `entries`. A refusal
 * carries only its reason, and that is the most useful thing on the line.
 *
 * Never guesses. Something with none of those fields gives an empty string, and the pane says the
 * call printed nothing rather than inventing a summary.
 */
export function outputOf(result: ToolOutcome): string {
  if (
    result.refused === true ||
    result.ok === false ||
    result.doneByPerson === true
  ) {
    // The reason was written to the Bot ("Do not try this action ... again"); a person reads theirs.
    return typeof result.reason === "string"
      ? outcomeForPerson(result.reason)
      : "";
  }

  // `text`, which is what the read route answers with. Not `contents`: that is the name on the way
  // in, and reading it back gave an empty pane for a file the Bot had just read out loud.
  if (typeof result.text === "string") return result.text;

  if (Array.isArray(result.entries)) {
    return result.entries
      .map((entry) => {
        if (!entry || typeof entry !== "object") return String(entry);
        const { path, kind, bytes } = entry as Record<string, unknown>;
        const label = String(path ?? "");
        // A trailing slash for a folder, the way a terminal marks one, so a listing of a workspace
        // full of folders does not read as a list of extensionless files.
        if (kind === "folder") return `${label}/`;
        return typeof bytes === "number" ? `${label}  ${bytes} bytes` : label;
      })
      .join("\n");
  }

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  // Both, in the order a terminal shows them, and labelled only when there is something on stderr:
  // most commands write nothing there and a permanent empty heading is noise.
  return stderr ? `${stdout}${stdout ? "\n" : ""}${stderr}` : stdout;
}

/** What one answered computer call did, as the pane draws it. */
export function detailsOf(
  kind: ComputerActivity["kind"],
  args: Record<string, unknown>,
  result: ToolOutcome,
): ActivityDetails {
  // Who did it, when the Bot did not: refused, or done by the person.
  const notTheBot = {
    ...(result.refused === true ? { refused: true } : {}),
    ...(result.declined === true ? { declined: true } : {}),
    ...(result.doneByPerson === true ? { doneByPerson: true } : {}),
  };
  const path = typeof args.path === "string" ? args.path : "";
  if (kind === "command")
    return {
      kind,
      subject: typeof args.command === "string" ? args.command : "",
      output: outputOf(result),
      ...(typeof result.exitCode === "number"
        ? { exitCode: result.exitCode }
        : {}),
      ...notTheBot,
      ...(result.truncated === true ? { truncated: true } : {}),
      ...(result.timedOut === true ? { timedOut: true } : {}),
    };
  if (kind === "write_file")
    return {
      kind,
      subject: path,
      /*
       * The path and the size, never the contents. A Bot may well be saving something it was told in
       * confidence, and the write route declines to echo it back for exactly that reason; putting it
       * in a pane would undo that. The arguments carry the contents, and they are not read here.
       */
      output:
        result.ok === false || result.doneByPerson === true
          ? outputOf(result)
          : typeof result.bytes === "number"
            ? `${result.bytes} bytes${args.append === true ? ", appended" : ""}`
            : "",
      ...notTheBot,
    };
  return {
    kind,
    subject: kind === "list_files" ? path || "the workspace" : path,
    output: outputOf(result),
    ...notTheBot,
  };
}

/**
 * The approval card a Bot asks with before a step it would rather not take unasked (`askApproval`,
 * `components/gallery/decisions.tsx`).
 *
 * Asked before deleting a file, a person said no, and the Bot never called the command: the
 * conversation held the card and its answer and nothing else, so Activity never listed the step.
 * A card that names the command it asks about is that step. Declined, it is listed as one the person
 * declined, in the words a declined command uses. Allowed, it is not listed at all: the command the
 * Bot runs next is the step, and it is listed once, with what it printed.
 */
const ASK_APPROVAL = "askApproval";

const approvals = new Map<string, { args: string; command: string | null }>();

/** The command an approval card asks about, or null when it names none. Read once per call's arguments. */
function commandAskedAbout(call: {
  id: string;
  function: { arguments: string };
}): string | null {
  const known = approvals.get(call.id);
  if (known && known.args === call.function.arguments) return known.command;
  const command = argumentsOf(call.function.arguments).command;
  return remember(approvals, call.id, {
    args: call.function.arguments,
    command:
      typeof command === "string" && command.trim() ? command.trim() : null,
  }).command;
}

/** What the person answered on an approval card: its `{ decision }`, or null when it is not an answer. */
function decisionIn(content: unknown): "approved" | "declined" | null {
  if (typeof content !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(content);
    const decision =
      parsed && typeof parsed === "object"
        ? (parsed as { decision?: unknown }).decision
        : undefined;
    return decision === "approved" || decision === "declined" ? decision : null;
  } catch {
    return null;
  }
}

/** A step the person declined before the Bot took it, as the pane draws one. */
function declinedCommand(command: string): ActivityDetails {
  return {
    kind: "command",
    subject: command,
    output: outcomeForPerson(DECLINED_BY_PERSON),
    refused: true,
    declined: true,
  };
}

/**
 * The computer calls a conversation holds, in the order they were made, each with what it did, or
 * null while it waits for its answer. An approval card that names a command counts as one until the
 * person allows it (see `ASK_APPROVAL`).
 *
 * The answers are gathered first, from anywhere in the conversation: a stored thread can hold a
 * result ahead of its own call (see `repair-history.ts`). The last real answer to a call is the one
 * read, so the server's answer stored beside the browser's placeholder wins, as it does in the
 * transcript (`chat-messages.ts`).
 */
export function conversationActivity(
  messages: readonly Message[],
): ConversationCall[] {
  const computerCalls = new Set<string>();
  const askingAbout = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (KINDS[call.function.name]) computerCalls.add(call.id);
      else if (call.function.name === ASK_APPROVAL) {
        const command = commandAskedAbout(call);
        if (command) askingAbout.set(call.id, command);
      }
    }
  }
  // Only the computer's answers, and the person's on those cards: another tool's can be long, and nothing here reads it.
  const answered = new Map<string, ToolOutcome>();
  const decided = new Map<string, "approved" | "declined">();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    if (computerCalls.has(message.toolCallId)) {
      const answer = answerOf(message);
      if (answer) answered.set(message.toolCallId, answer);
    } else if (askingAbout.has(message.toolCallId)) {
      const decision = decisionIn(message.content);
      if (decision) decided.set(message.toolCallId, decision);
    }
  }
  const calls: ConversationCall[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      const command = askingAbout.get(call.id);
      if (command !== undefined) {
        const decision = decided.get(call.id);
        if (decision === "approved") continue;
        calls.push({
          id: call.id,
          did: decision === "declined" ? declinedCommand(command) : null,
        });
        continue;
      }
      const kind = KINDS[call.function.name];
      if (!kind) continue;
      const answer = answered.get(call.id);
      calls.push({
        id: call.id,
        did: answer ? didOf(kind, call, answer) : null,
      });
    }
  }
  return calls;
}

/**
 * Keep a Bot's Activity pane in step with the conversation in front of the person.
 *
 * Read after every render of the surface holding the conversation rather than on a message event:
 * the SDK puts a frontend tool's answer into the conversation by splicing it into the message list,
 * which no event announces, and the conversation is drawn again on whatever comes next. Reading after
 * each render keeps the pane exactly as current as the transcript beside it, for one pass over the
 * messages with each answer parsed once.
 *
 * A call this page starts running is marked as watched when it starts, and only then: a quick answer
 * can land before the conversation is drawn again, and a render that catches a call unanswered may
 * be catching history as it is replayed (see `asked`). That covers all three ways a call runs, since
 * the browser starts every one of them, including those it hands to the gate. A step held for the
 * person before a reload is marked when they answer it here (`noteWatched`).
 */
export function useConversationActivity(
  computerId: string,
  messages: readonly Message[],
): void {
  const { copilotkit } = useCopilotKit();
  useEffect(
    () =>
      copilotkit.subscribe({
        onToolExecutionStart: ({ toolCallId, toolName }) => {
          // A card's handler starts when it is drawn to be answered, here.
          if (KINDS[toolName] || toolName === ASK_APPROVAL)
            noteWatched(toolCallId);
        },
      }).unsubscribe,
    [copilotkit],
  );
  useEffect(() => {
    recordActivity(computerId, conversationActivity(messages));
  });
}

/**
 * Which Bots have opened a page since the surface was loaded.
 *
 * Recorded rather than inferred from the screenshot: a screenshot always succeeds, and "the browser
 * has a page loaded" is a different fact from "this Bot opened one" — the screen belongs to the
 * computer and outlives a conversation, so a Bot that has browsed nothing still has a page on it.
 *
 * Nothing reads this today. The screen and the activity log are now stacked rather than tabbed, so
 * no view has to guess which of the two to open, and the caption that hedged about whose page it
 * was is gone with it. The note stays because the tool handler is the only place the fact exists and
 * losing it would mean re-deriving it from a screenshot, which cannot answer it.
 */
const browsed = new Set<string>();

export function noteBrowsed(computerId: string): void {
  if (browsed.has(computerId)) return;
  browsed.add(computerId);
  notify();
}

export function subscribeToActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Forget one computer's activity.
 *
 * Wiping a computer deletes the machine those commands ran on, so leaving them on screen would
 * describe something that no longer exists. They stay forgotten when the conversation is read again,
 * after a reload and in another tab as well, whether or not this page had read the conversation (see
 * `wipes`); what the Bot does from here on still appears.
 */
export function clearActivity(computerId: string): void {
  const previous = wipeOf(computerId);
  // Everything known about the machine before this wipe ran on it, the last wipe's newer calls too.
  const before = new Set([
    ...(previous?.before ?? []),
    ...(previous?.after ?? []),
    ...(taken.get(computerId) ?? []),
  ]);
  keepWipe(computerId, { at: Date.now(), before, after: new Set() });
  byComputer.delete(computerId);
  browsed.delete(computerId);
  notify();
}
