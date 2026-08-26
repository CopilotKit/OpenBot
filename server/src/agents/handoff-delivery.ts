/**
 * Running the Bot that was addressed, and letting its answer land in the conversation.
 *
 * The delivery half of a hop. `handoff-runner.ts` decides which hop and holds the lease; this knows
 * how to turn one into a turn.
 *
 * THROUGH THE PLATFORM'S OWN RUNNER, not by calling the agent and writing the result somewhere. The
 * runner is what persists a turn to a thread, so an answer delivered this way is the same kind of
 * object as one a person's run produced: it appears in the transcript, it is in the history the next
 * run reads, and it survives whichever pod produced it. Calling `agent.run` directly would produce
 * an answer nothing had recorded, which is the failure nobody can debug: the first Bot says it handed
 * the work over, the second says it answered, and no row anywhere agrees.
 */
import type { AbstractAgent, BaseEvent } from "@ag-ui/client";
import type { Observable } from "rxjs";
import type { HandoffDelivery } from "./handoff-runner";

/** Whatever runs an agent against a thread and records what it did. */
export type ThreadRunner = {
  run: (request: {
    threadId: string;
    agent: AbstractAgent;
    input: unknown;
  }) => Observable<BaseEvent>;
};

export function createHandoffDelivery(options: {
  /**
   * The addressed Bot, built for the person whose conversation this is.
   *
   * Built per hop and for that person, because a Bot's tools are resolved against their grants: the
   * second Bot runs as the same person, with its own role and its own grants, and must see what they
   * may see and no more.
   */
  agentFor: (input: {
    actorId: string;
    botId: string;
  }) => Promise<AbstractAgent | null>;
  /**
   * The conversation so far, so the addressed Bot is not answering out of context.
   *
   * PASSED THROUGH UNTOUCHED, which is why its shape is the reader's rather than named here. The
   * platform holds a thread's messages in its own type and takes them back in the same one; sitting
   * in the middle with a stricter type would mean inventing a conversion between two shapes that
   * already agree, and a conversion is a place to lose a message.
   */
  history: (input: {
    threadId: string;
    actorId: string;
  }) => Promise<readonly unknown[]>;
  runner: ThreadRunner;
  newRunId: () => string;
}): HandoffDelivery {
  const { agentFor, history, runner, newRunId } = options;

  return {
    async deliver({ work, message, assertion }) {
      const agent = await agentFor({
        actorId: work.actorId,
        botId: work.toBotId,
      });
      if (!agent) {
        /*
         * Thrown rather than swallowed, so the hop is released and tried again. A Bot that cannot be
         * built right now is usually a Bot whose endpoint is briefly unreachable or whose row is
         * mid-edit, and both of those come back.
         */
        throw new Error(`${work.toBotId} could not be built for this run`);
      }

      const runId = newRunId();
      const events = runner.run({
        threadId: work.threadId,
        agent,
        input: {
          threadId: work.threadId,
          runId,
          /*
           * The conversation, then the ask. The addressed Bot is joining something already in
           * progress and answering the person in it, so it needs to have read it: a Bot handed only
           * the task answers the question asked and misses that half of it was settled three
           * messages ago.
           */
          messages: [
            ...(await history({
              threadId: work.threadId,
              actorId: work.actorId,
            })),
            {
              id: `handoff-${runId}`,
              role: "user",
              content: message,
            },
          ],
          tools: [],
          context: [],
          state: {},
          /*
           * The deployment's own statement of what this run is, carrying how deep the chain has
           * gone. It is what stops the addressed Bot handing the work on for ever, and it is signed,
           * so the Bot cannot edit its own depth on the way past.
           */
          forwardedProps: { openbotRun: assertion },
        },
      });

      await settled(events);
    },
  };
}

/**
 * Wait for the run to be over, and fail if it failed.
 *
 * A RUN_ERROR has to reject, or the hop is finished and never retried while nothing was ever said in
 * the conversation. The stream completing without one is a turn that happened, whatever the Bot
 * decided to say: "I could not find that" is an answer, and asking again would spend another model
 * call on the same non-answer.
 */
function settled(events: Observable<BaseEvent>): Promise<void> {
  return new Promise((resolve, reject) => {
    let failure: Error | undefined;
    events.subscribe({
      next: (event) => {
        // Compared as a string rather than through the enum: `@ag-ui/client` re-exports the types
        // this file needs and not that value, and adding a second AG-UI package for one constant
        // would be a dependency to keep in step for no gain.
        if (event.type === "RUN_ERROR") {
          failure = new Error(
            (event as { message?: string }).message ??
              "the run ended in an error",
          );
        }
      },
      error: (error: unknown) =>
        reject(error instanceof Error ? error : new Error(String(error))),
      complete: () => (failure ? reject(failure) : resolve()),
    });
  });
}
