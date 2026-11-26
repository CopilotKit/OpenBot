import {
  createConversationJoinToken,
  getConversationRun,
} from "@/lib/api/generated/conversations/conversations";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";

/**
 * A run that has gone quiet, and whether it is still a run.
 *
 * FOUND IN TESTING, with the service that carries a conversation's events stalled mid-run. The Bot's
 * reply stopped half written and the step under it said "Running", with Stop up, for as long as
 * anybody watched. The server had given the run up after a minute. Nothing told this browser,
 * because a run's events reach it by that same service, and a run that ends without its last event
 * looks exactly like one that is thinking.
 *
 * SILENCE IS NOT THE SIGNAL. A Bot can think, or wait on an app, for minutes. After
 * {@link QUIET_RUN_MS} with nothing arriving, the server is ASKED whether the conversation still
 * has a run going, and asked again every {@link QUIET_RUN_MS} while it says yes. Only its answer
 * ends the turn: no run going, or no answer at all.
 */

/** How long nothing may arrive from a run before the server is asked about it. */
export const QUIET_RUN_MS = 45_000;

/**
 * The quiet period the conversation screen watches with. Always {@link QUIET_RUN_MS}; a test of the
 * whole screen shortens it, since nothing else can wait out three quarters of a minute.
 */
export const quietRunPeriod = { ms: QUIET_RUN_MS };

/** How long the server is given to answer. Past this it has not answered. */
export const LIVENESS_ANSWER_MS = 15_000;

/**
 * ONE ASK THE SERVER COULD NOT ANSWER IS NOT THE END OF THE RUN. Found on OpenBot Cloud: a long
 * answer across four apps went quiet on a slow app, the one ask about it never reached a server,
 * and the turn ended "lost touch" while the run went on, unharmed, on a server that was up all along.
 * Opened again, the conversation showed the run as it was and the notice and its Carry on were gone.
 * So an ask that is not answered is asked again {@link UNANSWERED_RETRY_MS} later, and only
 * {@link UNANSWERED_TRIES} in a row end the turn: about a minute and a half of a server that does
 * not answer, longer than a dropped connection or a server being replaced.
 */
export const UNANSWERED_RETRY_MS = 10_000;
export const UNANSWERED_TRIES = 3;

/**
 * What the server said: the conversation has a run going, it has none, or it could not say (it
 * refused, failed, or did not answer in time).
 */
export type RunLiveness = "live" | "over" | "unreachable";

/** Said under a turn whose run ended without telling this browser. */
export const RUN_ENDED_UNHEARD =
  "The Bot stopped before it finished. What it saved is shown here.";

/**
 * Said under a turn whose run could not be asked about. It does not say the message was sent: a
 * run that never started goes quiet the same way, and nothing here can tell the two apart.
 */
export const RUN_UNREACHABLE =
  "OpenBot lost touch with the Bot before it finished. Carry on once OpenBot is back.";

/** What a join token says about the conversation it is for: the run in progress, or none. */
type Joined = { runId: string | null };

/**
 * Ask whether this conversation has a run going, by asking for a join token for it (the API's
 * createConversationJoinToken): its answer names the run in progress, or none. The token itself is
 * not used. A conversation no Bot has run in yet has no run going either.
 */
export async function askRunLiveness(
  conversationId: string,
  options: {
    /** The API's join-token operation; a test gives its own. */
    join?: (conversationId: string, signal: AbortSignal) => Promise<Joined>;
    answerMs?: number;
  } = {},
): Promise<RunLiveness> {
  const join =
    options.join ??
    ((id: string, signal: AbortSignal) =>
      createConversationJoinToken(
        organizationId(),
        id,
        // Each ask is its own: the answer is about now.
        { "Idempotency-Key": idempotencyKey() },
        { signal },
      ));
  const answerMs = options.answerMs ?? LIVENESS_ANSWER_MS;
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), answerMs);
  try {
    const joined = await Promise.race([
      join(conversationId, giveUp.signal),
      // A request that ignores its signal has still not answered.
      new Promise<null>((resolve) => {
        giveUp.signal.addEventListener("abort", () => resolve(null), {
          once: true,
        });
      }),
    ]);
    if (joined === null) return "unreachable";
    return typeof joined.runId === "string" ? "live" : "over";
  } catch (error) {
    return error instanceof ClientError &&
      error.code === "CONVERSATION_NOT_STARTED"
      ? "over"
      : "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How a run this browser stopped hearing turned out, as the server keeps it: it finished, it stopped
 * part way (failed, was stopped, or stopped to ask somebody), or the server can't say.
 */
export type RunEnding = "finished" | "stopped" | "unknown";

/**
 * NO RUN GOING IS NOT THE SAME AS A RUN THAT STOPPED. Found on OpenBot Cloud in a phone's web view:
 * a long answer at the highest reasoning level finished, and its last events never reached the
 * phone, which had slept through them. When it woke, the quiet watch's time was long up, the server
 * said the conversation had no run going, and the turn ended "The Bot stopped before it finished"
 * with Carry on, under the whole answer read back from the thread.
 *
 * So once the server says no run is going, it is asked how the run this browser last heard start
 * ended (the API's getConversationRun), and only a run that finished is shown as finished. One the
 * server keeps no ending for yet is asked once more {@link RUN_ENDING_RETRY_MS} later: the server
 * writes a run's ending as the run ends, which can be a moment after it stops counting it as going.
 */
export const RUN_ENDING_RETRY_MS = 2_000;

/**
 * The run a RUN_STARTED names: its `runId`, which is the id the server keeps its ending under. Null
 * for a subagent's start, which is part of a run and not a run of its own.
 */
export function startedRunId(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const { runId, subagentRunId } = event as {
    runId?: unknown;
    subagentRunId?: unknown;
  };
  if (subagentRunId) return null;
  return typeof runId === "string" && runId ? runId : null;
}

export async function askRunEnding(
  conversationId: string,
  runId: string,
  options: {
    /** The API's getConversationRun; a test gives its own. */
    read?: (
      conversationId: string,
      runId: string,
      signal: AbortSignal,
    ) => Promise<{ run: { outcome: string | null } }>;
    answerMs?: number;
    retryMs?: number;
  } = {},
): Promise<RunEnding> {
  const read =
    options.read ??
    ((id: string, run: string, signal: AbortSignal) =>
      getConversationRun(organizationId(), id, run, { signal }));
  const answerMs = options.answerMs ?? LIVENESS_ANSWER_MS;
  const once = async (): Promise<RunEnding | null> => {
    const giveUp = new AbortController();
    const timer = setTimeout(() => giveUp.abort(), answerMs);
    try {
      const answered = await Promise.race([
        read(conversationId, runId, giveUp.signal),
        new Promise<null>((resolve) => {
          giveUp.signal.addEventListener("abort", () => resolve(null), {
            once: true,
          });
        }),
      ]);
      if (answered === null) return "unknown";
      const outcome = answered.run.outcome;
      if (outcome === "succeeded") return "finished";
      if (
        outcome === "failed" ||
        outcome === "cancelled" ||
        outcome === "interrupted"
      )
        return "stopped";
      // Going still, or ended without saying how; any other word is one this app doesn't know.
      return outcome === null ? null : "unknown";
    } catch (error) {
      // Not kept yet, or a server from before it kept endings: both answer not found.
      return error instanceof ClientError && error.status === 404
        ? null
        : "unknown";
    } finally {
      clearTimeout(timer);
    }
  };
  const first = await once();
  if (first !== null) return first;
  await new Promise((resolve) =>
    setTimeout(resolve, options.retryMs ?? RUN_ENDING_RETRY_MS),
  );
  return (await once()) ?? "unknown";
}

/**
 * Watch a run for quiet. `heard` is called for everything that arrives from it, and `rest` when
 * the server's run ends with the turn still going here. After `quietMs`
 * with nothing, `ask` is asked, and again each `quietMs` while it answers "live". The first other
 * answer settles `over`, once, and the watch stops. `stop` ends it with nothing settled.
 *
 * RESTING IS STILL WATCHED, FOR THE SERVER ITSELF. Between two runs of a turn the browser takes a
 * step of its own (it saves a file, runs a command), and that step is a request to the server. Found
 * on a person's 1.1.2 Desktop: the server stopped in the middle of such a step and Docker started it
 * again, and the step's request never came back, so the turn sat on "Thinking" for good with the
 * person's next message queued behind it. No run is expected while resting, so "over" and "live"
 * both mean the server is there and the step is still its own. Only "unreachable" ends a rest.
 *
 * TIME ASLEEP IS NOT QUIET. A phone stops a page it is not showing (the screen locks, another app
 * comes to the front) and drops its socket, and the run's events go on without it. Shown again, the
 * page's socket connects again and is sent what it missed, but the watch's time had run out while
 * it slept, so the server was asked at once, said the run was over, and the turn ended before the
 * rest of the reply could arrive. So a page shown again starts the quiet over (`onWake`), and an
 * answer already on its way is about the time asleep, so it is not taken.
 */
export function watchQuietRun(options: {
  ask: () => Promise<RunLiveness>;
  quietMs?: number;
  /** How long after an ask the server could not answer it is asked again. */
  retryMs?: number;
  /** How many asks in a row it may not answer before the turn is ended as unreachable. */
  unansweredTries?: number;
  /**
   * Calls `wake` whenever the page is shown again after it was hidden, and returns how to stop.
   * The page's own visibility unless a test gives its own.
   */
  onWake?: (wake: () => void) => () => void;
}): {
  heard: () => void;
  /**
   * The run on the server has ended and the turn is this browser's for now (a step it takes
   * itself, a card the person answers): no run is expected until `heard`, so only a server that
   * stops answering ends the watch.
   */
  rest: () => void;
  stop: () => void;
  over: Promise<Exclude<RunLiveness, "live">>;
} {
  const quietMs = options.quietMs ?? QUIET_RUN_MS;
  const retryMs = options.retryMs ?? UNANSWERED_RETRY_MS;
  const unansweredTries = options.unansweredTries ?? UNANSWERED_TRIES;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let asking = false;
  let resting = false;
  // The asks in a row the server could not answer.
  let unanswered = 0;
  // Whether anything arrived (or the run came to rest) while the server was being asked: its
  // answer is then about a moment that has passed.
  let heardSince = false;
  let settle: (outcome: Exclude<RunLiveness, "live">) => void = () => {};
  const over = new Promise<Exclude<RunLiveness, "live">>((resolve) => {
    settle = resolve;
  });
  const wait = (ms = quietMs) => {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => {
      asking = true;
      heardSince = false;
      const askedResting = resting;
      void options
        .ask()
        .catch(() => "unreachable" as const)
        .then((answer) => {
          asking = false;
          if (stopped) return;
          if (heardSince) {
            unanswered = 0;
            return wait();
          }
          // While resting no run is expected: a server that answers at all is still taking the step.
          if (answer === "live" || (askedResting && answer === "over")) {
            unanswered = 0;
            return wait();
          }
          // Not answered: asked again soon, and only a server that stays silent ends the turn.
          if (answer === "unreachable" && ++unanswered < unansweredTries)
            return wait(retryMs);
          stopped = true;
          forgetWakes();
          settle(answer);
        });
    }, ms);
  };
  wait();
  // Not `heard`: a page shown again says nothing of whether the run is resting between runs.
  const forgetWakes = (options.onWake ?? pageWakes)(() => {
    if (stopped) return;
    unanswered = 0;
    if (asking) heardSince = true;
    else wait();
  });
  return {
    // Something arrived: the quiet starts again, and an answer on its way is about a run that
    // has since spoken, so it is not taken.
    heard: () => {
      resting = false;
      unanswered = 0;
      if (asking) heardSince = true;
      else wait();
    },
    rest: () => {
      resting = true;
      if (asking) heardSince = true;
      else wait();
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      forgetWakes();
    },
    over,
  };
}

/** Calls `wake` each time the page is shown again. Nothing where there is no page. */
function pageWakes(wake: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const shown = () => {
    if (document.visibilityState === "visible") wake();
  };
  document.addEventListener("visibilitychange", shown);
  return () => document.removeEventListener("visibilitychange", shown);
}
