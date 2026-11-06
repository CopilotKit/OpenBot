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
  return said.trim() || "The Bot stopped without saying why.";
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
 * Subscribe before the connect starts: the agent hands a connect the subscribers it has then.
 */
export function followLastRun(agent: Pick<AbstractAgent, "subscribe">): {
  /** The last run's failure, in its own words, or null when it did not fail. */
  failure: () => string | null;
  stop: () => void;
} {
  let failure: string | null = null;
  let broken = false;
  const subscription = agent.subscribe({
    onRunStartedEvent: () => {
      failure = null;
    },
    onRunFinishedEvent: () => {
      failure = null;
    },
    onRunErrorEvent: ({ event }) => {
      failure = stoppedReason(event?.message);
    },
    onRunFailed: () => {
      broken = true;
    },
  });
  return {
    failure: () => (broken ? null : failure),
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
