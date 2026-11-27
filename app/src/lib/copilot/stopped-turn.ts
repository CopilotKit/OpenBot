import { type AbstractAgent, useAgent } from "@copilotkit/react-core/v2";
import { useEffect, useState } from "react";
import { botNoLongerUsable } from "@/lib/agents/queries";
import { startedRunId } from "@/lib/copilot/quiet-run";
import { problemRequestId, recordProblem } from "@/lib/desktop/problems";
import { useClearWhenHoldEnds } from "@/lib/held-ends";
import { type Failure, isHeld } from "@/lib/load-failure";
import { isPlanRequired, showCardNeeded } from "@/lib/plan/card-needed";

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
  notePlanRefusal(reported, said);
  const refused = refusalForPerson(said);
  if (refused) return refused;
  const unreachable = backEndUnreachable(said);
  if (unreachable) return unreachable;
  if (RUNNER_DROPPED.test(said.trim())) return TURN_CUT_OFF;
  if (AG_UI_RULE_BROKEN.test(said)) {
    console.warn("A Bot's event stream broke AG-UI's rules.", said);
    return UNREADABLE_REPLY;
  }
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

/**
 * The AG-UI client's own words for a stream that breaks its rules (`verifyEvents` in
 * `@ag-ui/client`): "Cannot send 'TOOL_CALL_START' event: A tool call with ID '…' is already in
 * progress. Complete it with 'TOOL_CALL_END' first.", and the same with no "event" for the rules about
 * who owns a message. Anywhere in what ended the run, which may put its own words in front.
 *
 * FOUND BY THE AG-UI CONFORMANCE SUITE. A connected Bot's adapter started one tool call twice, the
 * client refused the stream, and the run ended in those words, shown to the person word for word.
 * They name an event and a rule the person can do nothing with. The person is told what happened,
 * and the words go to the console for whoever debugs it, as `backEndUnreachable` does.
 */
const AG_UI_RULE_BROKEN = /Cannot send '[A-Z_]+'(?: event)?:/;

/**
 * Said under a turn a Bot's own stream broke: what it sent didn't follow AG-UI's rules, and the AG-UI
 * client refused it. Its work so far stands, and Carry on asks it to go on.
 */
export const UNREADABLE_REPLY =
  "The Bot sent something OpenBot couldn't read, so its turn ended. Ask it to carry on.";

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

/** The body of a REST failure the runtime's client reported, parsed, or null when there is none. */
function refusedBody(said: string): unknown {
  const match = REST_REQUEST_FAILED.exec(said.trim());
  if (!match) return null;
  try {
    return JSON.parse(said.trim().slice(match[0].length));
  } catch {
    return null;
  }
}

/**
 * A run refused for want of a plan opens the dialog that says why (`lib/plan/card-needed.ts`), on
 * top of the sentence said under the turn, so a run no screen checked first still tells the person.
 * Through Intelligence the refusal is the problem in the client's words; over the plain event stream
 * the error keeps the response's status, 402.
 */
function notePlanRefusal(reported: unknown, said: string): void {
  const status =
    reported instanceof Error
      ? (reported as Error & { status?: unknown }).status
      : undefined;
  const body = refusedBody(said);
  if (isPlanRequired(body)) showCardNeeded(body);
  else if (status === 402) showCardNeeded({});
}

/** Where OpenBot's own problems (RFC 9457) say what kind they are: `https://open.bot/errors/<code>`. */
const OPENBOT_PROBLEM = "https://open.bot/errors/";

/**
 * Whether a run failed because OpenBot's server refused it for the person, on a rule they can't
 * change by sending again (a model their teams don't allow, a switch an admin turned off, a card
 * the organization needs): its own problem, with a sentence for them. See `refusalForPerson`.
 */
export function refusedForPerson(reported: unknown): boolean {
  const said =
    reported instanceof Error
      ? reported.message
      : typeof reported === "string"
        ? reported
        : "";
  return refusalForPerson(said) !== null;
}

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
  const body = refusedBody(said);
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
  // 503: OpenBot may be holding off, which only the server can say (see `askAboutBot`).
  return status === 404 || status === 503 ? "run" : null;
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
): Promise<Failure> {
  const said = { message: stoppedReason(reported) };
  const request = refusedRequest(reported);
  if (!request) return said;
  const asked = await askAboutBot(botId, noLongerUsable);
  if (asked.held) return asked.held;
  if (!asked.gone) return said;
  return {
    message:
      request === "run" ? BOT_NOT_SHARED_MESSAGE_NOT_SENT : BOT_NOT_SHARED,
  };
}

/**
 * Why a later run of a turn failed (`laterRunFailure`), once the server has been asked whether it is
 * holding off. Its sentence otherwise: the Bot being taken away is not asked about part way through a
 * turn, as it never was.
 */
export async function laterRunReason(
  reported: unknown,
  said: string,
  botId: string,
  noLongerUsable: (botId: string) => Promise<boolean> = botNoLongerUsable,
): Promise<Failure> {
  if (!requestNotMade(reported)) return { message: said };
  const asked = await askAboutBot(botId, noLongerUsable);
  return asked.held ?? { message: said };
}

/**
 * The server asked about the Bot whose run was refused: whether it is gone, or whether OpenBot is
 * holding off for now.
 *
 * THE RUNTIME'S CLIENT LOSES A HOLD. While OpenBot moves an organization, or its database is briefly
 * out of reach, the runtime refuses a run 503 with the server's sentence and `Retry-After`, as every
 * address does. CopilotKit's client (`@copilotkit/core` 1.88.0, and still in 1.90.2) throws that as `REST run request failed: <the body>`, the status and the headers gone, and AG-UI's
 * HTTP agent keeps the status but not the headers. So the person was told OpenBot couldn't reach its
 * backend, in red. The app's own client keeps both, so the Bot is read through it: a read refused
 * with a hold is the same hold, and its sentence is said calmly (lib/load-failure.tsx).
 */
async function askAboutBot(
  botId: string,
  noLongerUsable: (botId: string) => Promise<boolean>,
): Promise<{ gone: boolean; held?: undefined } | { held: Failure }> {
  try {
    return { gone: await noLongerUsable(botId) };
  } catch (error) {
    return isHeld(error) ? { held: error as Failure } : { gone: false };
  }
}

/** Whether a failure is one `failedRunReason` may have a truer sentence for. */
export function requestNotMade(reported: unknown): boolean {
  return refusedRequest(reported) !== null;
}

/**
 * The code OpenBot's server puts on the RUN_ERROR of a run its Bot's engine couldn't take ("… can't
 * run because OpenBot's LangGraph engine isn't answering"). The server keeps that turn as a refused
 * one (`listRefusedTurns`, code BOT_ENGINE_UNAVAILABLE), so it is drawn as a refusal is: under the
 * message it refused, for good, not as the last turn's ending, which the next turn clears.
 */
export const BOT_ENGINE_UNAVAILABLE = "BOT_ENGINE_UNAVAILABLE";

/** Whether a RUN_ERROR ended a turn the server keeps as refused (`BOT_ENGINE_UNAVAILABLE`). */
export function refusedRun(event: unknown): boolean {
  return (
    !!event &&
    typeof event === "object" &&
    (event as { code?: unknown }).code === BOT_ENGINE_UNAVAILABLE
  );
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
 * NOR IS A REFUSED TURN (`refusedRun`). The server keeps it, and it is drawn under its message from
 * that record; read here too, it was said twice after a reload, the second time at the bottom.
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
  /** The id of the last run the join heard start, to ask the server how it ended. */
  runId: () => string | null;
  stop: () => void;
} {
  let failure: string | null = null;
  let broken = false;
  let running = false;
  let runId: string | null = null;
  const subscription = agent.subscribe({
    onRunStartedEvent: ({ event }) => {
      failure = null;
      running = true;
      runId = startedRunId(event) ?? runId;
    },
    onRunFinishedEvent: () => {
      failure = null;
      running = false;
    },
    onRunErrorEvent: ({ event }) => {
      failure = refusedRun(event) ? null : stoppedReason(event?.message);
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
    runId: () => runId,
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
export function useStoppedTurn(agentId: string): Failure | null {
  const { agent } = useAgent({ agentId });
  const [stopped, setStopped] = useState<Failure | null>(null);

  useEffect(
    () => watchStoppedTurn(agent, agentId, setStopped),
    [agent, agentId],
  );
  // A hold is about now: said until the organization answers again, then gone (lib/held-ends.ts).
  useClearWhenHoldEnds(stopped, () =>
    setStopped((shown) => (shown === stopped ? null : shown)),
  );

  return stopped;
}

/** The request id the problem body of a failed run carries (`REST run request failed: {…}`), if any. */
export function failureRequestId(reported: unknown): string | undefined {
  const said =
    reported instanceof Error
      ? reported.message
      : typeof reported === "string"
        ? reported
        : "";
  return problemRequestId(refusedBody(said));
}

/**
 * A run that failed is kept for the troubleshooting logs, and inside OpenBot Desktop handed to its
 * log, as the sentence the person was shown, with the server's request id when the failure carried
 * one. The runtime's own requests do not go through `lib/client.ts`, so this is how a broken reply
 * reaches the logs.
 *
 * Recorded whenever the sentence is shown. Opening a conversation replays how its last run ended,
 * with nothing that tells the replay from a run failing now, so a failure shown again is recorded
 * again, at the time it was shown.
 */
function recordFailedRun(sentence: string, reported: unknown): void {
  const requestId = failureRequestId(reported);
  recordProblem({
    kind: "run",
    message: sentence,
    ...(requestId ? { requestId } : {}),
  });
}

/**
 * What `useStoppedTurn` does with one agent: tells `setStopped` why each run that ends badly ended,
 * and null as the next one starts. That is its sentence, or the server's refusal kept whole when it
 * is OpenBot holding off, for `failureSaid` to draw calmly. Returns the function that stops watching.
 */
export function watchStoppedTurn(
  agent: Pick<AbstractAgent, "subscribe">,
  agentId: string,
  setStopped: (stopped: Failure | null) => void,
  noLongerUsable?: (botId: string) => Promise<boolean>,
): () => void {
  // Which run a sentence is about, so one that arrives after the next run began is dropped.
  let run = 0;
  const subscription = agent.subscribe?.({
    onRunInitialized: () => {
      run += 1;
      setStopped(null);
    },
    onRunErrorEvent: ({ event }) => {
      const sentence = stoppedReason(event?.message);
      setStopped({ message: sentence });
      recordFailedRun(sentence, event?.message);
    },
    onRunFailed: ({ error }) => {
      if (!requestNotMade(error)) {
        const sentence = stoppedReason(error);
        setStopped({ message: sentence });
        recordFailedRun(sentence, error);
        return;
      }
      // Said once the server has answered whether the Bot is still theirs, or OpenBot is holding
      // off, so the wrong sentence is never drawn first.
      const failed = run;
      void failedRunReason(error, agentId, noLongerUsable).then((reason) => {
        // A hold is not a failure, and is not kept as one.
        if (!isHeld(reason)) recordFailedRun(reason.message, error);
        if (failed === run) setStopped(reason);
      });
    },
  });
  return () => {
    run += 1;
    subscription?.unsubscribe();
  };
}
