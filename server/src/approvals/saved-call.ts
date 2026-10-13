import { isDeepStrictEqual } from "node:util";
import { ApprovalRefusedError } from "./types";

/** The slice of a saved conversation this check reads. */
export type SavedHistory = {
  messages: {
    role: string;
    toolCalls?: { id: string; name: string; args: string }[];
    toolCallId?: string;
  }[];
};

/** The call the browser asked the server to carry out on the Bot's computer. */
export type RequestedCall = {
  toolCallId: string;
  toolName: string;
  args: unknown;
};

export const SAVED_CALL_REFUSAL =
  "That unanswered tool call is not saved in this conversation.";

/**
 * Several times the longest save lag measured against managed Intelligence, where a click's
 * arguments took up to 14s to settle. See COMPUTER_SAVED_CALL_WAIT in docs/configuration.md.
 */
export const DEFAULT_SAVED_CALL_WAIT_MS = 60_000;
const POLL_INTERVAL_MS = 250;

type Reading =
  | { kind: "ready" }
  | { kind: "pending"; why: string }
  | { kind: "refused"; why: string };

/**
 * Reads one copy of the saved conversation against the requested call.
 *
 * The only final answer short of a match is a call that already has a saved result: that call has
 * been carried out, and running it again is a replay. Anything else that does not match may still
 * change. Intelligence saves a call's name and arguments as they stream, and saves those pieces out
 * of order: managed Intelligence has been seen holding `{"reff8e31snapshotId":59}` for a moment
 * before `{"ref":"f8e31","snapshotId":59}`, which parses, differs, and is not final. So a missing
 * call, a half-written name, arguments that do not parse to an object, and arguments that parse but
 * differ are all read again, and the deadline is what refuses them.
 */
function read(history: SavedHistory, requested: RequestedCall): Reading {
  if (
    history.messages.some(
      (message) =>
        message.role === "tool" && message.toolCallId === requested.toolCallId,
    )
  )
    return { kind: "refused", why: "the call already has a saved result" };
  const saved = history.messages
    .flatMap((message) => message.toolCalls ?? [])
    .find((call) => call.id === requested.toolCallId);
  if (!saved) return { kind: "pending", why: "the call is not saved yet" };
  if (saved.name !== requested.toolName)
    return {
      kind: "pending",
      why: `the saved call is named "${saved.name}", not ${requested.toolName}`,
    };
  // A tool's arguments are always an object, so anything that does not parse to one is unfinished.
  let parsed: unknown;
  try {
    parsed = JSON.parse(saved.args);
  } catch {
    return {
      kind: "pending",
      why: `the saved arguments do not parse (${saved.args.length} characters)`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { kind: "pending", why: "the saved arguments are not an object" };
  if (isDeepStrictEqual(parsed, requested.args)) return { kind: "ready" };
  // Names the fields that differ, never their values: a keystroke's text is in them.
  const asked =
    typeof requested.args === "object" && requested.args !== null
      ? (requested.args as Record<string, unknown>)
      : {};
  const differing = [
    ...new Set([...Object.keys(parsed), ...Object.keys(asked)]),
  ].filter(
    (key) =>
      !isDeepStrictEqual((parsed as Record<string, unknown>)[key], asked[key]),
  );
  return {
    kind: "pending",
    why: `the saved arguments (${saved.args.length} characters) differ from the request in ${differing.join(", ") || "their shape"}`,
  };
}

/**
 * Allows a computer action only once the conversation Intelligence has saved holds that exact,
 * unanswered tool call.
 *
 * This is what stops a forged request from driving a Bot's computer: the browser names the call, but
 * the action runs only if the Bot's own conversation, as saved, asked for it with these arguments.
 * Intelligence saves a streaming run a moment behind the stream, while the browser runs the tool as
 * soon as the call arrives, so a call that is missing, half-written or mid-repair is read again until
 * `waitMs` has passed. Nothing is allowed on a reading that is not an exact match.
 */
export async function requireSavedCall(
  load: () => Promise<SavedHistory>,
  requested: RequestedCall,
  options: {
    waitMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
    log?: (message: string) => void;
  },
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = options.log ?? ((message: string) => console.warn(message));
  const started = now();
  let readings = 0;
  let last: Reading;
  for (;;) {
    readings++;
    try {
      last = read(await load(), requested);
    } catch (error) {
      last = {
        kind: "pending",
        why: `the conversation could not be read (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    const elapsed = now() - started;
    if (last.kind === "ready") {
      if (readings > 1)
        log(
          `Computer action ${requested.toolName} (${requested.toolCallId}) found saved after ${elapsed}ms and ${readings} readings.`,
        );
      return;
    }
    if (last.kind === "refused" || elapsed >= options.waitMs) break;
    await sleep(Math.min(POLL_INTERVAL_MS, options.waitMs - elapsed));
  }
  log(
    `Refused computer action ${requested.toolName} (${requested.toolCallId}) after ${now() - started}ms and ${readings} readings: ${last.why}.`,
  );
  throw new ApprovalRefusedError(SAVED_CALL_REFUSAL);
}
