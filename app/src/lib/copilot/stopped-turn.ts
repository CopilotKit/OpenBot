import { type AbstractAgent, useAgent } from "@copilotkit/react-core/v2";
import { useEffect, useState } from "react";

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
  const unreachable = backEndUnreachable(said);
  if (unreachable) return unreachable;
  return said.trim() || "The Bot stopped without saying why.";
}

/**
 * The one reason that is NOT passed on in its own words: the browser couldn't reach the runtime.
 *
 * CopilotKit's Intelligence agent writes it as `REST <mode> request failed: <whatever came back>`,
 * and what came back is the server's raw body, JSON included (`{"error":"Failed to resolve Learning
 * Container"}`). Nothing in it is the person's to act on, so they are told what happened in their
 * terms and the original goes to the console for whoever is debugging.
 */
const REST_REQUEST_FAILED = /^REST (\w+) request failed\b/;

function backEndUnreachable(said: string): string | null {
  const match = REST_REQUEST_FAILED.exec(said.trim());
  if (!match) return null;
  console.warn("OpenBot couldn't reach its backend.", said);
  return match[1] === "run"
    ? "OpenBot couldn't reach its backend, so your message wasn't sent. Try again, or quit and reopen OpenBot."
    : "OpenBot couldn't reach its backend. Try again, or quit and reopen OpenBot.";
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
    const subscription = agent.subscribe?.({
      onRunInitialized: () => setStopped(null),
      onRunErrorEvent: ({ event }) => setStopped(stoppedReason(event?.message)),
      onRunFailed: ({ error }) => setStopped(stoppedReason(error)),
    });
    return () => subscription?.unsubscribe();
  }, [agent]);

  return stopped;
}
