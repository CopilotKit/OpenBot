import { type AbstractAgent, useAgent } from "@copilotkit/react-core/v2";
import { useEffect, useState } from "react";
import { botNoLongerUsable } from "@/lib/agents/queries";

/**
 * Why the last turn ended without an answer, for a surface that has to say so itself.
 *
 * A run can end three ways. It finishes, which needs no explanation. It fails in the browser, which
 * arrives as an error. Or the Bot's own stream stops producing anything and this deployment ends the
 * turn for it, which arrives as a RUN_ERROR carrying the sentence the server wrote (see
 * server/src/channels/stall-guard.ts). The last two both leave the same hole on screen: the composer
 * unlocks, the spinner disappears, and nothing says what happened.
 *
 * The reason is kept as a sentence rather than a flag because the reasons are not interchangeable. A
 * Bot that refused, a Bot whose endpoint is down and a Bot that simply stopped talking are three
 * different things to be told, and only the thing that ended the turn knows which one it was.
 */

/**
 * The sentence to show, in the words of whatever ended the turn.
 *
 * Falls back only when there is genuinely nothing to pass on. Saying "the Bot stopped without saying
 * why" is honest about that; inventing a cause would not be, and this is the one moment a person has
 * no other way to find out what went wrong.
 */
export function stoppedReason(reported: unknown): string {
  const said =
    reported instanceof Error
      ? reported.message
      : typeof reported === "string"
        ? reported
        : "";
  const refused = refusalForPerson(said);
  if (refused) return refused;
  const unreachable = backEndUnreachable(said);
  if (unreachable) return unreachable;
  if (RUNNER_DROPPED.test(said.trim())) return TURN_CUT_OFF;
  if (CONNECTION_CUT.test(said.trim())) {
    console.warn("A Bot's connection was cut part way through a turn.", said);
    return TURN_CUT_OFF;
  }
  return said.trim() || "The Bot stopped without saying why.";
}

/**
 * A fetch's own words for a connection that was cut part way: Bun's ("ECONNRESET: The socket
 * connection was closed unexpectedly. For more information, pass `verbose: true` in the second
 * argument to fetch()"), Node's ("socket hang up", "read ECONNRESET") and undici's ("terminated",
 * "other side closed"). Found on a Cloud dogfood: a Bot's connection to its model was cut, and the
 * run ended with Bun's sentence, which the conversation showed word for word, in red, with no way
 * on. Nothing in it is the person's to act on; the turn was cut off, and Carry on picks it up.
 */
const CONNECTION_CUT =
  /ECONNRESET|socket connection was closed unexpectedly|^socket hang up$|^other side closed$|^terminated$/i;

/**
 * Whether the server ended the turn asking the person to have the Bot carry on: a reply that came
 * back incomplete, or the connection to the Bot's model dropping part way ("The connection to Claude
 * dropped. Ask the Bot to carry on."). Those turns did work that stands, like a turn cut off here,
 * so they get the same Carry on.
 */
export function asksToCarryOn(said: string): boolean {
  return /\bAsk (?:it|the Bot) to carry on\.$/.test(said.trim());
}

/** Said under a turn cut off part way because OpenBot's backend stopped answering. Its work stands. */
export const TURN_CUT_OFF =
  "The Bot stopped before it finished because OpenBot's backend stopped answering. What it saved is shown here.";

/**
 * How the backend's event store ends a run whose server went away under it, word for word. Found
 * with the server killed and started again in the middle of a long turn: the conversation, opened
 * again, said only "Runner connection dropped", in words nobody using OpenBot can act on.
 */
const RUNNER_DROPPED = /^Runner connection dropped\.?$/i;

/** Whether a run ended because something here aborted it: Stop, Send now, or a step held for a person. */
function aborted(reported: unknown): boolean {
  if (!reported || typeof reported !== "object") return false;
  const name = (reported as { name?: unknown }).name;
  const message = (reported as { message?: unknown }).message;
  return (
    name === "AbortError" ||
    (typeof message === "string" && /\baborted\b/i.test(message))
  );
}

/**
 * Why a later run of a turn failed in this browser, or null when there is nothing to say.
 *
 * A TURN THAT TOUCHES THE BROWSER IS SEVERAL RUNS. The first ends on a step the browser takes (it
 * saves a file), and the next run is started from here carrying that step's result. Found on a
 * person's 1.1.2 Desktop: the server stopped and started again in the middle of a long turn of file
 * saves, the next run's request was never made, and the turn ended with nothing said. Its last save
 * was drawn "Not run" only once they wrote again. A failure there was dropped as if it were Stop.
 *
 * So it is said, unless something here stopped it. A request that never reached the server does not
 * say "your message wasn't sent", as it would for a first run: the message went, and the Bot worked on
 * it, so what it did is kept and the person is told the turn was cut off.
 */
export function laterRunFailure(reported: unknown): string | null {
  if (aborted(reported)) return null;
  const said =
    reported instanceof Error
      ? reported.message
      : typeof reported === "string"
        ? reported
        : "";
  if (refusalForPerson(said)) return stoppedReason(reported);
  if (
    REST_REQUEST_FAILED.test(said.trim()) ||
    /failed to fetch|load failed|networkerror|network connection/i.test(said)
  ) {
    console.warn(
      "OpenBot couldn't reach its backend part way through a turn.",
      said,
    );
    return TURN_CUT_OFF;
  }
  return stoppedReason(reported);
}

/**
 * The one reason that is NOT passed on in its own words: the browser couldn't reach the runtime.
 *
 * CopilotKit's Intelligence agent writes it as `REST <mode> request failed: <whatever came back>`,
 * and what came back is the server's raw body, JSON included (`{"error":"Failed to resolve Learning
 * Container"}`). Nothing in it is the person's to act on, so they are told what happened in their
 * terms and the original goes to the console for whoever is debugging.
 */
const REST_REQUEST_FAILED = /^REST (\w+) request failed\b:?\s*/;

/** Where OpenBot's own problems (RFC 9457) say what kind they are: `https://open.bot/errors/<code>`. */
const OPENBOT_PROBLEM = "https://open.bot/errors/";

/**
 * The sentence OpenBot's server wrote for the person, when a REST failure is its refusal.
 *
 * The server refuses a run it may not start (an admin's model allowlist, a switch that is off) with
 * a problem whose `type` is OpenBot's own and whose `detail` is written for the person. The client
 * throws that body as it came, the status gone, so the body has to say itself that it is one: an
 * OpenBot problem, about the request (4xx), with a `detail`. Anything else, a raw `{ error }`
 * included, is not, and is still the backend failing.
 */
function refusalForPerson(said: string): string | null {
  const match = REST_REQUEST_FAILED.exec(said.trim());
  if (!match) return null;
  let body: unknown;
  try {
    body = JSON.parse(said.trim().slice(match[0].length));
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const { type, status, detail } = body as Record<string, unknown>;
  return typeof type === "string" &&
    type.startsWith(OPENBOT_PROBLEM) &&
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    typeof detail === "string" &&
    detail.trim()
    ? detail.trim()
    : null;
}

function backEndUnreachable(said: string): string | null {
  const match = REST_REQUEST_FAILED.exec(said.trim());
  if (!match) return null;
  console.warn("OpenBot couldn't reach its backend.", said);
  return match[1] === "run"
    ? "OpenBot couldn't reach its backend, so your message wasn't sent. Try again, or quit and reopen OpenBot."
    : "OpenBot couldn't reach its backend. Try again, or quit and reopen OpenBot.";
}

/**
 * The request the runtime refused or never made, when that is what was reported and the Bot having
 * been taken away could be why. Null for everything else, a Bot's own failure included.
 *
 * The two ways a run travels report it differently. Through Intelligence, the client throws a plain
 * `Error` reading `REST <mode> request failed: <the body>`, its `cause` another plain `Error` with
 * the body as its message: the status and the response are gone by then, so any such failure may be
 * a refusal. Over the plain event stream, AG-UI's HTTP agent throws an error that keeps the
 * response's `status`, and only a 404 is the runtime saying the Bot is not one of this person's.
 */
function refusedRequest(reported: unknown): "run" | "connect" | null {
  const said =
    reported instanceof Error
      ? reported.message
      : typeof reported === "string"
        ? reported
        : "";
  // The server already said why, for the person: nothing to ask it again.
  if (refusalForPerson(said)) return null;
  const rest = REST_REQUEST_FAILED.exec(said.trim())?.[1];
  if (rest) return rest === "run" ? "run" : "connect";
  const status =
    reported instanceof Error
      ? (reported as Error & { status?: unknown }).status
      : undefined;
  return status === 404 ? "run" : null;
}

/** What a person reads when the Bot they were talking to is not one they can use any more. */
export const BOT_NOT_SHARED_MESSAGE_NOT_SENT =
  "This Bot isn't shared with you any more, so your message wasn't sent. Its owner or an admin can share it again.";
export const BOT_NOT_SHARED =
  "This Bot isn't shared with you any more. Its owner or an admin can share it again.";

/**
 * Why a run failed, when the failure may be the Bot having been taken away and not the back end.
 *
 * A person in a conversation with a Bot shared with their team is taken out of the team. Their next
 * message is refused, rightly: the runtime answers the run request 404, because the Bot is not one of
 * theirs. Through Intelligence the runtime client reports that exactly as it reports a back end
 * that is down (see `refusedRequest`), so the person was told OpenBot couldn't reach its back end
 * and to quit and reopen it, which was false and could not help.
 *
 * So the server is asked: the Bot is read again through the API, and only its own "not found" (404)
 * says the Bot is not theirs any more. A read that fails any other way, or a Bot that is still
 * there, leaves the sentence as it was, so a network failure and a server that broke are still
 * called what they are.
 *
 * Never rejects: this is the sentence for a failure, and has to come back with one.
 */
export async function failedRunReason(
  reported: unknown,
  botId: string,
  noLongerUsable: (botId: string) => Promise<boolean> = botNoLongerUsable,
): Promise<string> {
  const said = stoppedReason(reported);
  const request = refusedRequest(reported);
  if (!request) return said;
  const gone = await noLongerUsable(botId).catch(() => false);
  if (!gone) return said;
  return request === "run" ? BOT_NOT_SHARED_MESSAGE_NOT_SENT : BOT_NOT_SHARED;
}

/** Whether a failure is one `failedRunReason` may have a truer sentence for. */
export function requestNotMade(reported: unknown): boolean {
  return refusedRequest(reported) !== null;
}

/**
 * How the last run in a thread's history ended, heard while the history is replayed.
 *
 * THE FAILURE IS NOT IN THE MESSAGES. A run that fails ends with a RUN_ERROR, which is an event, and
 * a thread's stored messages are only what was said. So a reload, or coming back later, showed the
 * person's message with nothing under it and no sign the run had failed.
 *
 * THE EVENT IS KEPT, THOUGH. The runtime stores every run's events, its terminal one included, and
 * joining the thread replays them to this browser run after run: the Intelligence gateway from its
 * event store, the in-memory runner from its own. That replay is the record of how each run ended,
 * in the words that ended it, so it is read here rather than kept a second time somewhere else.
 *
 * ONLY THE LAST RUN COUNTS. A run that started after a failure supersedes it, whatever came of it:
 * one that answered makes the failure old news, and one still going is not over yet.
 *
 * A STOP IS NOT A FAILURE, and needs nothing special: a run the person stopped ends with
 * RUN_FINISHED, outcome cancelled, as the runtime records it.
 *
 * NOTHING WHEN THE REPLAY BROKE. A connect that failed part way may have stopped after an old failure
 * and before the run that answered it, and a stale failure is worse than none. The caller drops the
 * answer the same way when the join ran out of time.
 *
 * STILL GOING IS HEARD TOO. A run the replay started and has not ended is a turn the Bot is answering
 * now, and the join is what carries the rest of it to this screen (see `joinWithin`).
 *
 * Subscribe before the connect starts: the agent hands a connect the subscribers it has then.
 */
export function followLastRun(agent: Pick<AbstractAgent, "subscribe">): {
  /** The last run's failure, in its own words, or null when it did not fail. */
  failure: () => string | null;
  /** Whether the last run the join has heard of started and has not ended yet. */
  running: () => boolean;
  stop: () => void;
} {
  let failure: string | null = null;
  let broken = false;
  let running = false;
  const subscription = agent.subscribe({
    onRunStartedEvent: () => {
      failure = null;
      running = true;
    },
    onRunFinishedEvent: () => {
      failure = null;
      running = false;
    },
    onRunErrorEvent: ({ event }) => {
      failure = stoppedReason(event?.message);
      running = false;
    },
    onRunFailed: () => {
      broken = true;
      running = false;
    },
  });
  return {
    failure: () => (broken ? null : failure),
    running: () => !broken && running,
    stop: () => subscription.unsubscribe(),
  };
}

/**
 * Watch one Bot's runs and hold on to the reason the last one ended, if it ended badly.
 *
 * Bound by agent id rather than handed an agent, so a caller that only renders the packaged chat
 * does not have to reach for one: `useAgent` returns the same shared instance the chat itself binds
 * to, so this watches exactly the runs that chat starts.
 *
 * Cleared when the next run begins rather than on a timer. A sentence about a turn that is over
 * should stay until there is something newer to look at, and the person deciding when that is is the
 * one who sends the next message.
 */
export function useStoppedTurn(agentId: string): string | null {
  const { agent } = useAgent({ agentId });
  const [stopped, setStopped] = useState<string | null>(null);

  useEffect(() => {
    // Which run a sentence is about, so one that arrives after the next run began is dropped.
    let run = 0;
    const subscription = agent.subscribe?.({
      onRunInitialized: () => {
        run += 1;
        setStopped(null);
      },
      onRunErrorEvent: ({ event }) => setStopped(stoppedReason(event?.message)),
      onRunFailed: ({ error }) => {
        if (!requestNotMade(error)) return setStopped(stoppedReason(error));
        // Said once the server has answered whether the Bot is still theirs, so the wrong sentence
        // is never drawn first.
        const failed = run;
        void failedRunReason(error, agentId).then((reason) => {
          if (failed === run) setStopped(reason);
        });
      },
    });
    return () => {
      run += 1;
      subscription?.unsubscribe();
    };
  }, [agent, agentId]);

  return stopped;
}
