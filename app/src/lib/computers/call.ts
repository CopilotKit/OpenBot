import { OUTCOME_UNKNOWN } from "@openbot/shared/approval-outcomes";
import { COMPUTER_START_WAIT_MS } from "@openbot/shared/computer-start";
import {
  clickComputer,
  listComputerFiles,
  navigateComputer,
  pressComputerKey,
  readComputerFile,
  readComputerPage,
  requestComputerControl,
  requestComputerSecret,
  runComputerCommand,
  scrollComputer,
  snapshotComputer,
  typeComputer,
  writeComputerFile,
} from "@/lib/api/generated/computers/computers";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";
import {
  reportComputerActivity,
  withdrawComputerActivity,
} from "@/lib/copilot/computer-activity";

export type ToolOutcome = Record<string, unknown> & { ok: boolean };

/**
 * The calls that never reach the Bot's screen.
 *
 * Reading a file or running a command happens on the computer, not on the display, so announcing
 * them opened the live screen on whatever still page was already there — a pane that arrived for an
 * action nobody could see, which is indistinguishable from one that arrived for no reason.
 *
 * A LIST OF EXCEPTIONS, NOT A LIST OF PERMITS, and deliberately so: a browser path added later and
 * never added here goes on announcing itself, which is what every browser path already does. The
 * failure mode of forgetting this list is a pane that opens, not one that silently stops.
 */
const OFF_SCREEN_PATHS = new Set([
  "/files/list",
  "/files/read",
  "/files/write",
  "/exec",
]);

type Body = Record<string, unknown>;
type Options = { signal?: AbortSignal };

/** A write's key: one per call, so a retry the network makes is the same write. */
const once = () => ({ "Idempotency-Key": idempotencyKey() });

/**
 * Only what the API's contract names for the call, so a stray argument a model added is not sent,
 * and the step it answers (`StepIds`) when the call carries it.
 */
function only<T>(body: Body | undefined, fields: readonly string[]): T {
  const kept: Body = {};
  for (const field of [...fields, "threadId", "toolCallId"])
    if (body?.[field] !== undefined) kept[field] = body[field];
  return kept as T;
}

/**
 * The Bot's tool call a computer call answers: its conversation's thread and the call's id.
 *
 * SENT WITH EVERY CALL A BOT MAKES, so the server runs the step once, whoever asks for it. The server
 * runs a Bot's computer steps itself, and a page that asks for one it has already run, or is running
 * (an older page, a second tab, a reload part way through), is answered with that run's result, or
 * told it is still going, and nothing is done a second time. Both or neither: one without the other
 * names no step.
 */
export type StepIds = { threadId: string; toolCallId: string };

/** The step a tool call's context names, when it names both its thread and its call. */
export function stepOf(context: {
  agent?: { threadId?: string };
  toolCall?: { id?: string };
}): StepIds | undefined {
  const threadId = context.agent?.threadId;
  const toolCallId = context.toolCall?.id;
  return threadId && toolCallId ? { threadId, toolCallId } : undefined;
}

/**
 * Each call a Bot makes on its computer, at the API's address for it
 * (`/api/v2/organizations/{organizationId}/computers/{botId}/...`), through the generated client.
 * Keyed by the name the tools have always called it by.
 */
const CALLS: Record<
  string,
  (botId: string, body: Body | undefined, options: Options) => Promise<unknown>
> = {
  "/read": (botId, body, options) =>
    readComputerPage(organizationId(), botId, only(body, []), options),
  "/snapshot": (botId, body, options) =>
    snapshotComputer(
      organizationId(),
      botId,
      once(),
      body?.threadId !== undefined ? only(body, []) : undefined,
      options,
    ),
  "/navigate": (botId, body, options) =>
    navigateComputer(
      organizationId(),
      botId,
      only(body, ["url"]),
      once(),
      options,
    ),
  "/click": (botId, body, options) =>
    clickComputer(
      organizationId(),
      botId,
      only(body, ["ref", "snapshotId"]),
      once(),
      options,
    ),
  "/type": (botId, body, options) =>
    typeComputer(
      organizationId(),
      botId,
      only(body, ["ref", "snapshotId", "text", "submit"]),
      once(),
      options,
    ),
  "/key": (botId, body, options) =>
    pressComputerKey(
      organizationId(),
      botId,
      only(body, ["key", "ref", "snapshotId"]),
      once(),
      options,
    ),
  "/scroll": (botId, body, options) =>
    scrollComputer(
      organizationId(),
      botId,
      only(body, ["deltaY"]),
      once(),
      options,
    ),
  "/exec": (botId, body, options) =>
    runComputerCommand(
      organizationId(),
      botId,
      only(body, ["command", "timeoutMs"]),
      once(),
      options,
    ),
  "/files/list": (botId, body, options) =>
    listComputerFiles(
      organizationId(),
      botId,
      only(body, ["path"]),
      once(),
      options,
    ),
  "/files/read": (botId, body, options) =>
    readComputerFile(
      organizationId(),
      botId,
      only(body, ["path"]),
      once(),
      options,
    ),
  "/files/write": (botId, body, options) =>
    writeComputerFile(
      organizationId(),
      botId,
      only(body, ["path", "contents", "append"]),
      once(),
      options,
    ),
  "/control/request": (botId, body, options) =>
    requestComputerControl(
      organizationId(),
      botId,
      only(body, ["reason", "source"]),
      once(),
      options,
    ),
  "/control/secret": (botId, body, options) =>
    requestComputerSecret(
      organizationId(),
      botId,
      only(body, ["ref", "snapshotId", "label"]),
      once(),
      options,
    ),
};

/**
 * Exported for the test that covers what a Bot is told when a call is refused.
 *
 * The distinctions this draws from a status and a body decide the model's next step, and they are
 * drawn nowhere else, so they are worth pinning without standing up the tool registrations and the
 * runtime around them.
 */
export async function callComputer(
  botId: string,
  path: string,
  /*
   * A body, not a `RequestInit`. The client serialises it, so a caller that stringified first would
   * send a JSON string of a JSON string, which is what happened, briefly, when this moved over.
   */
  init?: { method?: string; body?: unknown; step?: StepIds },
  signal?: AbortSignal,
  clock: StartClock = REAL_CLOCK,
): Promise<ToolOutcome> {
  // Announce before the call so the screen can open while the action is running.
  const run = OFF_SCREEN_PATHS.has(path) ? null : reportComputerActivity(botId);
  const call = CALLS[path];
  // A call the API has no address for was not made.
  if (!call) return { ok: false, reason: "That did not work." };
  const sent = {
    ...init,
    body: {
      ...(init?.body && typeof init.body === "object" ? init.body : {}),
      ...init?.step,
    },
  };
  /*
   * ASKED AGAIN WHILE THE COMPUTER IS STILL STARTING, until COMPUTER_START_WAIT_MS has gone.
   *
   * One request is answered inside what an edge in front of the server lets it wait, which is less
   * than a cold computer can take to come up. Its answer then says the computer is still starting
   * and nothing was done, so asking again cannot do the thing twice. Asked again here, the Bot's call
   * waits for the computer as long as a Bot's own turn does, and the line keeps saying the step is
   * under way, rather than the model being told to try again and a plan reading that as a failure.
   */
  const startedAt = clock.now();
  for (;;) {
    const outcome = await callOnce(botId, call, run, sent, signal);
    /*
     * A STEP THE SERVER IS RUNNING ALREADY is not run here: it is asked about again, with the same
     * step, until the server's run of it answers, and its answer is this call's. As long as it takes:
     * the step is under way, as a command that runs for minutes is.
     */
    if (outcome.stepRunning === true) {
      await clock.pause(START_ASK_AGAIN_MS, signal);
      if (signal?.aborted)
        return { ok: false, reason: "Stopped.", stopped: true };
      continue;
    }
    if (outcome.starting !== true) return outcome;
    const left = COMPUTER_START_WAIT_MS - (clock.now() - startedAt);
    if (left <= 0) return outcome;
    await clock.pause(Math.min(START_ASK_AGAIN_MS, left), signal);
    if (signal?.aborted)
      return { ok: false, reason: "Stopped.", stopped: true };
  }
}

/** Time, as the start wait reads it. A test hands its own, so it need not wait minutes. */
export type StartClock = {
  now(): number;
  /** Resolves after `ms`, or at once when `signal` is aborted. */
  pause(ms: number, signal?: AbortSignal): Promise<void>;
};

const REAL_CLOCK: StartClock = {
  now: () => Date.now(),
  pause: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    }),
};

/** The pause before asking again about a computer still starting. Each answer has already waited on it. */
const START_ASK_AGAIN_MS = 2_000;

/** One request for the call, and what the Bot is told about its answer. */
async function callOnce(
  botId: string,
  call: (typeof CALLS)[string],
  run: ReturnType<typeof reportComputerActivity> | null,
  init: { method?: string; body?: unknown } | undefined,
  signal: AbortSignal | undefined,
): Promise<ToolOutcome> {
  try {
    const body = await call(
      botId,
      init?.body && typeof init.body === "object"
        ? (init.body as Body)
        : undefined,
      // Abort cancels the request and prevents later actions, but cannot undo browser work already executing.
      signal ? { signal } : {},
    );
    return { ok: true, ...((body as Body | undefined) ?? {}) };
  } catch (error) {
    // An abort is a stopped run, not a computer failure.
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, reason: "Stopped.", stopped: true };
    }
    /*
     * ALREADY DONE, AND ITS ANSWER IS NOT KEPT. What a snapshot, a command or a file answered is what
     * was on the computer, so the API keeps no copy to answer a retry with: when the network sent
     * this call a second time under the same key, the first one ran and this one is told so. That is
     * neither a failure nor a refusal, so the Bot is told the step happened and that its result is
     * gone, and asks again only if it needs it. Nobody is shown an error for it.
     */
    if (error instanceof ClientError && error.code === "ANSWER_NOT_KEPT") {
      return {
        ok: true,
        alreadyDone: true,
        resultUnavailable: true,
        note: "This was already done. Its result is no longer available: do it again only if you need the result.",
      };
    }
    // The server is running this step already: asked about again, never run here (`callComputer`).
    if (error instanceof ClientError && error.code === "COMPUTER_STEP_RUNNING")
      return { ok: false, stepRunning: true, notPerformed: true };
    /*
     * The server started this step once and was cut off before it answered, so nobody knows whether
     * it happened. Not run again: the Bot is told to check first, and the step reads "Didn't run".
     */
    if (
      error instanceof ClientError &&
      error.code === "COMPUTER_STEP_OUTCOME_UNKNOWN"
    )
      return { ok: false, outcomeUnknown: true, reason: OUTCOME_UNKNOWN };
    if (error instanceof ClientError) {
      /*
       * A REFUSAL IS AN INTENTION, NOT AN ACTION. 403 is a policy, a capability switch or a network
       * rule saying no, and it says so before the browser is touched: there is nothing on the screen
       * to see, because nothing was done to it. Every other failure reached the computer and may have
       * moved it, so those keep the screen they opened.
       */
      if (error.status === 403 && run !== null)
        withdrawComputerActivity(botId, run);
      return failedComputerCall(error.status, problemAsToday(error));
    }
    return {
      ok: false,
      reason: "The assistant's computer could not be reached.",
    };
  }
}

/**
 * A problem the API refused a call with, as the body today's route answers for the same refusal:
 * the sentence as `error`, and the flags `failedComputerCall` decides a Bot's next step from. The
 * problem's code says which case it is; `rule`, `snapshotRequired`, `controlRequestId` and `handoff`
 * ride beside it.
 */
export function problemAsToday(error: ClientError): Record<string, unknown> {
  const problem = error.body ?? {};
  return {
    error: error.message,
    ...(error.code === "COMPUTER_STARTING" ? { starting: true } : {}),
    ...(error.code === "COMPUTER_NEEDS_CONVERSATION"
      ? { needsConversation: true }
      : {}),
    ...(typeof problem.rule === "string" ? { rule: problem.rule } : {}),
    ...(error.code === "COMPUTER_PERSON_HAS_CONTROL"
      ? {
          humanHasControl: true,
          requestId: problem.controlRequestId,
          handoff: problem.handoff,
        }
      : {}),
    ...(problem.snapshotRequired === true ? { snapshotRequired: true } : {}),
  };
}

/**
 * What a Bot is told when a computer call came back refused or failed.
 *
 * A result, never a thrown error. The SDK starts no follow-up run after a frontend tool throws, so a
 * throw ends the Bot's turn on the spot with nothing said; a result reaches the model, which can take
 * a fresh snapshot, pick another field, or tell the person what stopped it. Shared with the approval
 * gate's wrapper, which reaches the same computer by another route and must answer the same way.
 */
export function failedComputerCall(
  status: number,
  body: Record<string, unknown> | null,
): ToolOutcome {
  /*
   * A cold start that outlasted the server's wait. Said as what it is: the computer is starting, this
   * call did nothing, and asking again shortly is the right next step. Kept apart from the failures
   * below so the line in the transcript reads as a wait, and so the model is not handed something
   * that looks like a broken computer and gives up on one seconds from ready.
   */
  if (body?.starting === true) {
    return {
      ok: false,
      starting: true,
      notPerformed: true,
      reason:
        typeof body.error === "string"
          ? body.error
          : "The computer is still starting. This call was not performed. Try it again in a moment.",
    };
  }
  /*
   * A rule wants to ask about this call, and it went straight to the computer without its
   * conversation. Nothing was done. `useFrontendTool` in approval-tools sends it again through the
   * approval route, so this result only reaches the Bot from a surface with no conversation at all.
   */
  if (body?.needsConversation === true) {
    return {
      ok: false,
      needsConversation: true,
      notPerformed: true,
      reason:
        typeof body.error === "string"
          ? body.error
          : "This action needs your approval in a chat with this Bot.",
    };
  }
  return {
    ok: false,
    reason: typeof body?.error === "string" ? body.error : "That did not work.",
    // Preserve refusal/stale-ref/control distinctions for the model's next step.
    ...(status === 403 ? { refused: true, rule: body?.rule ?? null } : {}),
    ...(status === 409
      ? body?.humanHasControl === true
        ? {
            humanHasControl: true,
            requestId: body?.requestId,
            handoff: body?.handoff,
          }
        : body?.snapshotRequired === true
          ? { staleRefs: true, snapshotRequired: true }
          : { staleRefs: true }
      : {}),
  };
}
