import { type ClientOptions, tryClient } from "@/lib/client";
import { newId } from "../new-id";

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
 * {@link QUIET_RUN_MS} with nothing arriving, the runtime is ASKED whether the conversation still
 * has a run going, and asked again every {@link QUIET_RUN_MS} while it says yes. Only its answer
 * ends the turn: no run going, or no answer at all.
 */

/** How long nothing may arrive from a run before the runtime is asked about it. */
export const QUIET_RUN_MS = 45_000;

/** How long the runtime is given to answer. Past this it has not answered. */
export const LIVENESS_ANSWER_MS = 15_000;

/**
 * What the runtime said: the conversation has a run going, it has none, or it could not say (it
 * refused, failed, or did not answer in time).
 */
export type RunLiveness = "live" | "over" | "unreachable";

/** Said under a turn whose run ended without telling this browser. */
export const RUN_ENDED_UNHEARD =
  "The Bot stopped before it finished. What it saved is shown here. Send a message to carry on.";

/**
 * Said under a turn whose run could not be asked about. It does not say the message was sent: a
 * run that never started goes quiet the same way, and nothing here can tell the two apart.
 */
export const RUN_UNREACHABLE =
  "OpenBot lost touch with the Bot before it finished. Try again in a moment, or reload to see what was saved.";

/**
 * Ask the runtime whether this conversation has a run going, by the call a conversation is joined
 * with: it answers the live run's id when there is one, and none when there is not.
 */
export async function askRunLiveness(
  agentId: string,
  threadId: string,
  options: {
    request?: (path: string, options: ClientOptions) => Promise<Response>;
    answerMs?: number;
  } = {},
): Promise<RunLiveness> {
  const request = options.request ?? tryClient;
  const answerMs = options.answerMs ?? LIVENESS_ANSWER_MS;
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), answerMs);
  try {
    const response = await Promise.race([
      request(`/api/copilotkit/agent/${encodeURIComponent(agentId)}/connect`, {
        method: "POST",
        body: {
          threadId,
          runId: newId(),
          messages: [],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
        signal: giveUp.signal,
      }),
      // A request that ignores its signal has still not answered.
      new Promise<null>((resolve) => {
        giveUp.signal.addEventListener("abort", () => resolve(null), {
          once: true,
        });
      }),
    ]);
    if (response === null) return "unreachable";
    if (response.status === 204) return "over";
    if (!response.ok) return "unreachable";
    const body: unknown = await response.json().catch(() => null);
    if (body === null || typeof body !== "object") return "unreachable";
    return typeof (body as { runId?: unknown }).runId === "string"
      ? "live"
      : "over";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Watch a run for quiet. `heard` is called for everything that arrives from it, and `rest` when
 * the server's run ends with the turn still going here. After `quietMs`
 * with nothing, `ask` is asked, and again each `quietMs` while it answers "live". The first other
 * answer settles `over`, once, and the watch stops. `stop` ends it with nothing settled.
 */
export function watchQuietRun(options: {
  ask: () => Promise<RunLiveness>;
  quietMs?: number;
}): {
  heard: () => void;
  /**
   * The run on the server has ended and the turn is this browser's for now (a step it takes
   * itself, a card the person answers): nothing is expected, so nothing is asked, until `heard`.
   */
  rest: () => void;
  stop: () => void;
  over: Promise<Exclude<RunLiveness, "live">>;
} {
  const quietMs = options.quietMs ?? QUIET_RUN_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let asking = false;
  // Whether anything arrived while the runtime was being asked: its answer is then out of date.
  let heardSince = false;
  let settle: (outcome: Exclude<RunLiveness, "live">) => void = () => {};
  const over = new Promise<Exclude<RunLiveness, "live">>((resolve) => {
    settle = resolve;
  });
  const wait = () => {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => {
      asking = true;
      heardSince = false;
      void options
        .ask()
        .catch(() => "unreachable" as const)
        .then((answer) => {
          asking = false;
          if (stopped) return;
          // Resting: the answer is about a run that has since ended in the ordinary way.
          if (heardSince && timer === undefined) return;
          if (answer === "live" || heardSince) return wait();
          stopped = true;
          settle(answer);
        });
    }, quietMs);
  };
  wait();
  return {
    // Something arrived: the quiet starts again, and an answer on its way is about a run that
    // has since spoken, so it is not taken.
    heard: () => {
      if (asking) heardSince = true;
      else wait();
    },
    rest: () => {
      heardSince = true;
      clearTimeout(timer);
      timer = undefined;
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
    over,
  };
}
