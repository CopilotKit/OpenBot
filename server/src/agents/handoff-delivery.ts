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
import { textOf } from "./message-text";

/** Whatever runs an agent against a thread and records what it did. */
export type ThreadRunner = {
  run: (request: {
    threadId: string;
    agent: AbstractAgent;
    input: unknown;
    /** What the conversation keeps, when that is not the whole of what the model was sent. */
    persistedInputMessages?: readonly unknown[];
  }) => Observable<BaseEvent>;
};

/**
 * The conversation's run lock.
 *
 * ONE RUN AT A TIME PER CONVERSATION, taken before anything is streamed. The platform hands the lock
 * out through an ordinary authenticated call and hands back the token that proves it: a run that
 * skips this and starts streaming is refused, because it is claiming to be a run nobody was told
 * about. That is what every delivery did before this existed, and the refusal read like a platform
 * limitation rather than a missing step.
 *
 * Taken with `NX`, so a conversation somebody else is already running in refuses rather than queues.
 * That is the right answer and the hop simply waits its turn: it is released back to the queue and
 * tried again, which is a wait rather than a failure.
 */
export type ThreadLock = {
  /**
   * The run id the platform issued, or null when somebody else is running in this conversation.
   *
   * ITS OWN ID, NOT THE ONE ASKED FOR. That id is what the gateway checks every streamed event
   * against, so a run that used the local one would be claiming to be a run nobody was told about.
   */
  acquire: (input: {
    threadId: string;
    runId: string;
    userId: string;
    agentId: string;
  }) => Promise<{ runId: string } | null>;
  /** Keep it while the addressed Bot works. The lock expires on its own otherwise. */
  renew: (input: { threadId: string; runId: string }) => Promise<void>;
  /** Give it back, so the next run does not wait out the whole expiry. */
  release: (input: { threadId: string; runId: string }) => Promise<void>;
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
  lock: ThreadLock;
  /**
   * A fresh thread of the addressed Bot's own, where its working happens out of sight.
   *
   * NOT THE CONVERSATION THAT ASKED, and this is a property of the platform rather than a choice. An
   * Intelligence thread is owned by exactly one agent: `assertThreadAgentOwnership` refuses any other
   * one, and the managed-channel path that relaxes USER ownership still enforces agent ownership. A
   * second Bot answering inside the first Bot's thread is not something this platform can express
   * today, whatever the caller does.
   *
   * A scratch thread rather than the Bot's own channel with the person, which is where answers used
   * to land. Two conversations for one question meant the person read the answer somewhere they
   * never asked anything; now the runner relays what came back through the Bot that asked, in the
   * conversation they are actually watching, and the scratch thread is never mapped to a channel so
   * nobody is shown it. It still exists on the platform, which is what makes the turn a recorded
   * run rather than an unlogged model call.
   */
  mintThreadId: () => string;
  /**
   * Tell the roster a conversation moved, when a turn put words in it.
   *
   * A HOP HAS NOBODY WATCHING. A conversation's place in the list and the line under its name are
   * written by the browser when somebody's own run finishes; a hop finishes on a server with no
   * browser attached, so without this a relayed answer lands in a conversation that never bumps,
   * never reads as unread, and is found by accident. Routines have the same problem and the same
   * answer: `recordActivity`, from the server, when the turn is on record.
   *
   * Keyed by thread rather than channel, because the thread is all a delivery knows. The wiring
   * resolves which channel shows that thread — and a scratch thread resolves to nothing, which is
   * a no-op rather than a mistake.
   */
  announce?: (input: {
    actorId: string;
    threadId: string;
    agentId: string;
    text: string;
  }) => Promise<void>;
  /**
   * Show the asking conversation as working while a FORWARD hop runs, and stop when it is over.
   *
   * Only the forward leg, and keyed on the asking thread — `work.threadId`, the conversation the
   * person is waiting in — because that leg runs in a scratch thread nobody watches. A backwards
   * hop runs in the asking thread itself, whose lock the runtime already lights through its own
   * busy signal, so this leaves that leg alone rather than double it. Best-effort and paired in a
   * `finally`, so a channel never stays lit because a run threw.
   */
  setBusy?: (input: { threadId: string; busy: boolean }) => Promise<void>;
  newRunId: () => string;
  /**
   * How long one delivery may take before it is given up on.
   *
   * A HOP MUST BE BOUNDED, because nothing else bounds it. The addressed Bot's run is an ordinary
   * agent turn: a model that stops mid-stream, a tool waiting on something that never arrives, a
   * browser that never loads the page. On a person's own run there is somebody watching who can
   * reload the page; a hop has nobody, and an unbounded one holds the conversation's lock, holds its
   * place on the queue and leaves the person waiting on an answer that is never coming, with the
   * conversation it was asked in locked against them for as long as the process lives.
   */
  deadlineMs?: number;
}): HandoffDelivery {
  const {
    agentFor,
    history,
    runner,
    lock,
    mintThreadId,
    announce,
    setBusy,
    newRunId,
    deadlineMs = DEFAULT_DELIVERY_DEADLINE_MS,
  } = options;

  return {
    async deliver({ work, message, shown, assertion }) {
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

      /*
       * What the addressed Bot actually did, kept so a hop that failed can say so.
       *
       * A hop has nobody watching it. When one goes wrong the only question worth answering first is
       * how far it got: a Bot that said twenty things and stopped is a stalled model, and one that
       * said nothing at all never reached its model. Those are different faults with different
       * fixes, and without this they are the same silence.
       *
       * The runner publishes events to the platform rather than through the observable it returns,
       * so the count has to be taken at the agent. Patched onto the instance, which is built fresh
       * for this one delivery, rather than wrapped: the runner reads the agent's own fields and
       * calls its methods, and a stand-in that proxies them is a second thing to keep in step.
       */
      const seen = { count: 0, last: "" };
      /*
       * What the addressed Bot said, gathered from the stream as it goes past.
       *
       * The runner publishes the turn to the platform rather than back through the observable, so
       * the text exists nowhere this function can read after the fact — the events are the one
       * chance to hear it. It is what the relay carries back to the conversation that asked, and
       * with the answer no longer landing in a channel of its own, this is the only copy a person
       * will ever be shown.
       */
      const said: string[] = [];
      let saying = "";
      const runAgent =
        typeof agent.runAgent === "function"
          ? agent.runAgent.bind(agent)
          : undefined;
      if (runAgent)
        (agent as { runAgent: unknown }).runAgent = (
          input: unknown,
          config?: { onEvent?: (emitted: unknown) => void },
        ) =>
          runAgent(
            input as never,
            {
              ...(config ?? {}),
              onEvent: (emitted: {
                event?: { type?: unknown; delta?: unknown };
              }) => {
                seen.count += 1;
                const type = String(emitted?.event?.type ?? "");
                seen.last = type;
                if (type === "TEXT_MESSAGE_START") saying = "";
                if (type === "TEXT_MESSAGE_CONTENT")
                  saying += String(emitted?.event?.delta ?? "");
                if (type === "TEXT_MESSAGE_END" && saying.trim().length > 0)
                  said.push(saying.trim());
                config?.onEvent?.(emitted);
              },
            } as never,
          );

      /*
       * The conversation this turn runs in.
       *
       * Named on the hop for the kind that goes backwards — the asking Bot speaking in the
       * conversation the person is watching, to relay an answer or a failure. Every forward hop
       * runs in a scratch thread of the addressed Bot's own, because a thread has exactly one
       * agent; what it says there comes back to the person through the relay, not the thread.
       */
      const where: { threadId: string } = work.answerIn
        ? { threadId: work.answerIn }
        : { threadId: mintThreadId() };

      /*
       * A forward hop lights the asking channel while it runs, because its own run is in a scratch
       * thread nobody sees. A backwards hop — a relay or a notice — runs in the asking thread
       * itself, so the runtime's own thread lock already lights it through `onRunBusy`, and
       * signalling here too would double up. So this covers only the leg the lock cannot: the
       * addressed Bot thinking, off-screen, on behalf of a channel the person is watching.
       */
      const lightsAskingChannel = !work.answerIn;
      if (lightsAskingChannel) {
        await setBusy?.({ threadId: work.threadId, busy: true }).catch(
          () => {},
        );
      }
      try {
        /*
         * The conversation that ASKED, not the one it is answering in. The addressed Bot is joining
         * something already in progress and has to have read it; its own conversation is new and
         * empty, and reading that would tell it nothing.
         *
         * READ BEFORE THE LOCK IS TAKEN, deliberately. The lock is on `where.threadId` and this read
         * is of `work.threadId` — a conversation the lock never protected — and the read is the one
         * call here that throws on a platform error. Thrown while holding the lock it would leak it
         * until the TTL: on a relay that lock is the asking conversation itself, so the person could
         * not type for two minutes and the retry would collide with the hop's own leftover hold.
         */
        const prior = conversationOnly(
          await history({ threadId: work.threadId, actorId: work.actorId }),
        );

        /*
         * The conversation's lock, before a single event is streamed.
         *
         * The platform's run id is the one it hands back, not the one asked for: it is the identity the
         * gateway will check every streamed event against, so using the local one would be claiming to
         * be a run that does not exist.
         */
        const held = await lock.acquire({
          threadId: where.threadId,
          runId: newRunId(),
          userId: work.actorId,
          agentId: work.toBotId,
        });
        if (!held) {
          /*
           * Somebody else is running in this conversation. Thrown so the hop goes back on the queue
           * and is tried again: a person mid-question, or the Bot that asked still finishing its own
           * sentence, is a wait rather than a failure.
           */
          throw new Error(
            `${where.threadId} is busy with another run; the hop will be tried again`,
          );
        }

        const runId = held.runId;

        /*
         * THE CONVERSATION GOES ON THE AGENT, NOT IN THE RUN.
         *
         * `runAgent` takes `runId`, `tools`, `context` and `forwardedProps` and nothing else: AG-UI
         * keeps the messages and the thread on the agent itself, and builds the run's input from them.
         * A `messages` array passed as a parameter is silently ignored, which is the worst shape a
         * mistake can take. Nothing failed. The addressed Bot ran, against an empty conversation, and
         * answered "how can I help?" to a question it had never been shown, in a transcript that
         * displayed the question directly above the answer.
         */
        const asked = [
          /*
           * A backwards hop gets the tail, not the whole. Its task already carries everything it has
           * to say — the answer, or the failure — and the person is waiting through this run's
           * time-to-first-token: a long channel read in full would make relaying an answer slower
           * the longer the conversation that wanted it. A few recent turns keep the voice and the
           * pronouns right; the rest is weight.
           */
          ...(work.answerIn ? prior.slice(-RELAY_CONTEXT_MESSAGES) : prior),
          { id: `handoff-${runId}`, role: "user", content: message },
        ];
        agent.threadId = where.threadId;
        // The platform's own message type rather than AG-UI's, which is what `history` returns: the
        // two agree where it matters, and converting between them is a place to lose a message.
        agent.setMessages(asked as Parameters<AbstractAgent["setMessages"]>[0]);
        /*
         * Renewed while the addressed Bot works, because the lock expires on its own. A run is minutes
         * and the platform's window is short; a lock that lapses mid-answer lets a second run into the
         * conversation, which is the thing it exists to prevent.
         */
        const heartbeat = setInterval(() => {
          void lock.renew({ threadId: where.threadId, runId }).catch(() => {});
        }, LOCK_RENEW_EVERY_MS);

        try {
          await settled(
            runner.run({
              threadId: where.threadId,
              agent,
              /*
               * What the conversation KEEPS, which is not what the model was sent.
               *
               * The runner persists whatever it is given here, and given nothing it persists the whole
               * prompt: the asking conversation's history repeated into a second conversation, and a
               * paragraph of instructions to a model sitting in a bubble that looks like something the
               * person typed. What belongs in a transcript is the one line saying why this Bot spoke.
               */
              persistedInputMessages: shown
                ? [{ id: `handoff-${runId}`, role: "user", content: shown }]
                : [],
              /*
               * NOTHING IS PASSED FOR THE CONNECTION, and that is load-bearing.
               *
               * The lock hands back a join token as well as a run id, and it reads like the thing to
               * present here. It is not: it is what a BROWSER presents to join a conversation and
               * watch it, and the runner's socket is a different connection with its own credential.
               * Handing it in overrides that credential, the socket is refused, and because the runner
               * treats a socket that will not connect as something to keep retrying rather than as a
               * failed run, nothing is ever emitted and nothing ever completes. The hop hangs, in
               * total silence, until the deadline below ends it.
               *
               * What makes this run legitimate is the lock itself: the gateway compares the run id on
               * every event to the one the lock holds. Taking the lock is the whole of the ceremony.
               */
              input: {
                threadId: where.threadId,
                runId,
                /*
                 * The same conversation the agent was given, so the run's own record of what it was
                 * asked agrees with what it read.
                 */
                messages: asked,
                tools: [],
                context: [],
                state: {},
                /*
                 * The deployment's own statement of what this run is, carrying how deep the chain has
                 * gone. It is what stops the addressed Bot handing the work on for ever, and it is
                 * signed, so the Bot cannot edit its own depth on the way past.
                 */
                forwardedProps: { openbotRun: assertion },
              },
            }),
            deadlineMs,
            () =>
              `${work.toBotId} did not finish within ${Math.round(deadlineMs / 1000)}s ${
                seen.count === 0
                  ? "and never reached its model"
                  : `after ${seen.count} events, the last ${seen.last}`
              }`,
          );
          /*
           * Only once the run is on record, and only when it said something: a conversation lifted to
           * the top of somebody's list for a turn that failed, or said nothing, is a conversation
           * they open to find nothing new.
           */
          if (announce && said.length > 0) {
            await announce({
              actorId: work.actorId,
              threadId: where.threadId,
              agentId: work.toBotId,
              text: said.join("\n\n"),
            }).catch(() => {
              // The turn happened. A roster that has not caught up is worth less than a hop reported
              // as failed and run a second time.
            });
          }
        } finally {
          clearInterval(heartbeat);
          /*
           * Given back whatever happened. Left held, the conversation is unusable by anybody until the
           * lock expires: the person cannot ask a follow-up and the next hop is refused, which turns
           * one failed delivery into a conversation that has stopped working.
           */
          /*
           * The conversation the lock was taken on, which is the one being answered in and NOT the one
           * that asked. Releasing the asking conversation's lock instead leaves this one held until it
           * lapses: the person cannot type in it and the next hop to the same Bot is refused, while a
           * lock somebody else may be holding on the asking side is dropped from under them.
           */
          await lock
            .release({ threadId: where.threadId, runId })
            .catch(() => {});
        }
      } finally {
        if (lightsAskingChannel) {
          await setBusy?.({ threadId: work.threadId, busy: false }).catch(
            () => {},
          );
        }
      }

      /*
       * What came back, for the runner to relay. Null when the turn produced no words at all —
       * a run that only called tools — which the runner treats as nothing worth carrying back.
       */
      return { answer: said.length > 0 ? said.join("\n\n") : null };
    },
  };
}

/**
 * The conversation, as a person would read it, with the asking Bot's tool traffic left out.
 *
 * A THREAD'S STORED HISTORY IS NOT A VALID PROMPT ON ITS OWN. What the platform keeps is what a
 * person is shown: the messages, and the results of the tools that ran. It does not keep the
 * assistant message that made a tool call, so the result is stored as a `tool` message whose
 * `toolCallId` matches nothing in the thread. Sent to a model as-is that is a malformed request, and
 * a hop delivered it every time: the asking Bot's own call to hand the work on is always the last
 * thing to have run, so the poison was in the history of every conversation that had asked.
 *
 * It is the right message to leave out on its own terms, too. The addressed Bot is being brought
 * into a conversation, not into another Bot's workings: those calls name tools it does not have,
 * carry arguments it was never meant to read, and say nothing about what the person wants. What
 * carries across a hop is what was said.
 */
function conversationOnly(messages: readonly unknown[]): readonly unknown[] {
  return messages.filter((message) => {
    if (typeof message !== "object" || message === null) return false;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") return false;
    // An assistant message with nothing in it is a tool call and nothing else. Keeping it would put
    // back the half of the pair that has no counterpart, which is the failure being fixed.
    return textOf(content).length > 0;
  });
}

/**
 * How much of the asking conversation a backwards hop reads.
 *
 * Six messages is about three exchanges: enough for the relaying Bot to keep its footing in the
 * conversation it is speaking into, and small enough that the read never grows with the channel.
 */
const RELAY_CONTEXT_MESSAGES = 6;

/**
 * How often the conversation's lock is refreshed while a Bot is working.
 *
 * Comfortably inside the platform's window, because a renewal that lands after it has lapsed is not
 * a renewal: the conversation is already free and something else may be in it.
 */
const LOCK_RENEW_EVERY_MS = 30_000;

/**
 * How long one hop may run for by default.
 *
 * Long enough for a real answer and short enough to be a wait rather than a hang. A Bot that reads a
 * corpus, drives a browser and writes a paragraph is minutes, not seconds, so a tight bound would
 * cut off working deliveries; but a person who has been told their question was handed on will not
 * wait a quarter of an hour to be told it was not, and the conversation stays locked for every
 * second of it.
 */
const DEFAULT_DELIVERY_DEADLINE_MS = 5 * 60_000;

/**
 * Wait for the run to be over, and fail if it failed.
 *
 * A RUN_ERROR has to reject, or the hop is finished and never retried while nothing was ever said in
 * the conversation. The stream completing without one is a turn that happened, whatever the Bot
 * decided to say: "I could not find that" is an answer, and asking again would spend another model
 * call on the same non-answer.
 */
function settled(
  events: Observable<BaseEvent>,
  deadlineMs: number,
  /** Written when the deadline passes, so it can say how far the run had got by then. */
  timedOut: () => string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let failure: Error | undefined;
    let done = false;
    /*
     * Declared before the subscription rather than closed over it, because an observable is entitled
     * to finish inside `subscribe` itself: a stream that is already complete calls back before the
     * call that started it has returned, and a `const subscription` would not exist yet.
     */
    let subscription: { unsubscribe: () => void } | undefined;
    /*
     * Unsubscribed on the way out, not merely abandoned. The subscription is what holds the run's
     * socket open, so a delivery that walked away from a stalled one would leak a connection per
     * attempt and go on paying for a run nobody is reading.
     */
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      subscription?.unsubscribe();
      settle();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(timedOut())));
    }, deadlineMs);
    subscription = events.subscribe({
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
        finish(() =>
          reject(error instanceof Error ? error : new Error(String(error))),
        ),
      complete: () => finish(() => (failure ? reject(failure) : resolve())),
    });
    // The stream that finished inside `subscribe`: `finish` had nothing to unsubscribe from at the
    // time, and the subscription it could not reach is this one.
    if (done) subscription.unsubscribe();
  });
}
