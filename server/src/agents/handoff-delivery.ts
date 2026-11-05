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
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { answerMessageId } from "@openbot/shared/handoff-markers";
import { THREAD_LOCK_TTL_SECONDS } from "@openbot/toolkit/copilotkit/thread-lock";
import { keepLease } from "@openbot/toolkit/lease";
import type { ThreadLock, TurnAdmission } from "@openbot/toolkit/ports";
import {
  observeDetachedRun,
  type PlatformRun,
  type StopRecorder,
} from "@openbot/toolkit/run-stop";
import { from, type Observable } from "rxjs";
import type { AuditInitiator } from "../audit";
import type { HandoffDelivery, HandoffWork } from "./handoff-runner";
import { textOf } from "./message-text";

/** Whatever runs an agent against a thread and records what it did. */

/**
 * The conversation an answer belongs in still has a run going after the hop waited for it (see
 * `BUSY_WAIT_MS`), so the hop goes back on the queue and the first retry comes quickly rather than a
 * minute later.
 */
export class ThreadBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadBusyError";
  }
}

export type ThreadRunner = {
  run: (request: {
    threadId: string;
    agent: AbstractAgent;
    input: unknown;
    /** What the conversation keeps, when that is not the whole of what the model was sent. */
    persistedInputMessages?: readonly unknown[];
    /** Called by a runner that records its own stops with Intelligence. */
    recordStop?: StopRecorder;
  }) => Observable<BaseEvent>;
  /** Stop a run in flight, as a pause does for every other turn. */
  stop?: (input: { threadId: string; runId: string }) => Promise<unknown>;
};

export function createHandoffDelivery(options: {
  prepareRunInput?: (
    input: {
      threadId: string;
      runId: string;
      messages: unknown[];
      tools: never[];
      context: never[];
      state: object;
      forwardedProps: { openbotRun: string };
    },
    work: import("./handoff-runner").HandoffWork,
  ) => Promise<unknown>;
  /**
   * The hop's analytics context, for the thread lock alone. Asked for before the lock, since the
   * lock is what starts the run on the platform; the run input never carries it.
   */
  /**
   * The run's `recordStop`, so a hop stopped here (a pause, the deadline) reads as cancelled on the
   * platform. Absent, or answering undefined, where the client cannot record a stop.
   */
  recordStopFor?: (
    run: PlatformRun,
    holdsLock: () => boolean,
  ) => StopRecorder | undefined;
  /** A stop this delivery knows it made, a pause, or one Intelligence relayed. Never a lost lock. */
  onKnownStop?: (
    actorId: string,
    runId: string,
    reason: "cancelled",
  ) => Promise<void>;
  analyticsContextFor?: (
    run: { threadId: string; runId: string },
    work: import("./handoff-runner").HandoffWork,
  ) => Promise<Record<string, unknown> | undefined>;
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
    /** The Bot that handed the work on, so the trail says a hop ran this and not the person. */
    fromBotId: string;
    /** What started the original run, so a Bot built for a hop still knows who it ultimately acts for. */
    initiator?: AuditInitiator;
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
   * never asked anything; now the runner carries what came back into the conversation they are
   * actually watching, as the answering Bot's own message, and the scratch thread is never mapped
   * to a channel so nobody is shown it. It still exists on the platform, which is what makes the
   * turn a recorded run rather than an unlogged model call.
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
    /** The Bot whose words these are, when they are not the thread's own Bot's. */
    answeredBy?: string;
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
  /**
   * How long a hop waits for the conversation it speaks in to be free before handing the hop back to
   * the queue. Overridden by tests; see `BUSY_WAIT_MS`.
   */
  busyWaitMs?: number;
  /** How often the lock is renewed while the Bot works. Overridden by tests; see `LOCK_RENEW_EVERY_MS`. */
  renewEveryMs?: number;
  /**
   * How long the lock lives without a renewal. Renewals failing for longer than this mean it has
   * lapsed, and the hop stops. Overridden by tests; the platform applies its own 120 seconds.
   */
  lockLifetimeMs?: number;
  /**
   * The same admission every headless turn meets: the pause guard and the enterprise controls. See
   * `serverTurnAdmission` in turn-admission.ts.
   */
  admission: TurnAdmission;
}): HandoffDelivery {
  const {
    admission,
    agentFor,
    history,
    runner,
    lock,
    mintThreadId,
    announce,
    setBusy,
    newRunId,
    deadlineMs = DEFAULT_DELIVERY_DEADLINE_MS,
    busyWaitMs = BUSY_WAIT_MS,
    renewEveryMs = LOCK_RENEW_EVERY_MS,
    lockLifetimeMs = THREAD_LOCK_TTL_SECONDS * 1000,
  } = options;

  return {
    async deliver({ work, message, shown, assertion }) {
      /*
       * Admitted before anything else, as every headless turn is: refused if the person paused the
       * Bot while this hop waited, or if "Use Bots" or the model allowlist refuse it, before the Bot
       * is built, the history read or the conversation locked. A refused hop used to take the lock
       * first, so a paused Bot's relay held the person's own channel for a moment on every retry.
       * The signal it returns aborts if they pause the Bot while it works, on this replica at once
       * and from any other through the watcher. The runner's check before claiming is not enough on
       * its own, because a hop runs for minutes.
       */
      const paused = await admission({
        ownerUserId: work.actorId,
        agentId: work.toBotId,
        threadId: work.answerIn ?? undefined,
      });
      /*
       * An answer going home is said, not generated. The Bot that was asked has already answered;
       * what is left is putting its words in the person's conversation under its name, which needs
       * the conversation's lock and its recorder and no model at all.
       */
      const spoken =
        work.answerIn && typeof work.answer === "string" && work.answer.trim()
          ? work.answer
          : null;
      const agent: AbstractAgent | null = spoken
        ? new SpokenAnswer({
            botId: work.fromBotId,
            name: work.fromName ?? work.fromBotId,
            text: spoken,
          })
        : await agentFor({
            actorId: work.actorId,
            botId: work.toBotId,
            fromBotId: work.fromBotId,
            ...(work.initiator ? { initiator: work.initiator } : {}),
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
        const prior = spoken
          ? []
          : conversationOnly(
              await history({ threadId: work.threadId, actorId: work.actorId }),
            );

        /*
         * The conversation's lock, before a single event is streamed.
         *
         * The platform's run id is the one it hands back, not the one asked for: it is the identity the
         * gateway will check every streamed event against, so using the local one would be claiming to
         * be a run that does not exist.
         */
        const requested = { threadId: where.threadId, runId: newRunId() };
        const analyticsContext = await options
          .analyticsContextFor?.(requested, work)
          .catch(() => {
            console.warn(
              JSON.stringify({
                type: "product-telemetry",
                reason: "handoff_context_failed",
              }),
            );
            return undefined;
          });
        /*
         * Waited for, a little, when somebody else is running in it. An answer going home usually
         * lands while the Bot that asked is still finishing the sentence that said it had asked,
         * which is seconds: taking the lock the moment it is free puts the answer on screen then,
         * rather than after a trip round the queue, and keeps the platform's refusal what it is, an
         * ordinary "not yet" (IntelligenceKnowingANewThread does not print it).
         */
        const held = await acquireWhenFree(
          () =>
            lock.acquire({
              ...requested,
              userId: work.actorId,
              agentId: work.toBotId,
              ...(analyticsContext ? { analyticsContext } : {}),
            }),
          busyWaitMs,
          paused,
        );
        if (!held) {
          /*
           * Still somebody else's after the wait: a person mid-question, most likely. Thrown so the
           * hop goes back on the queue and is tried again, which is a wait rather than a failure.
           */
          throw new ThreadBusyError(
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
        const asked = spoken
          ? []
          : work.answerIn
            ? [
                /*
                 * A backwards hop gets the tail, not the whole. Its task already carries everything
                 * it has to say — the failure — and the person is waiting through this run's
                 * time-to-first-token: a long channel read in full would make it slower the longer
                 * the conversation. A few recent turns keep the voice and the pronouns right; the
                 * rest is weight. It is the asking Bot's own conversation, so its turns are its own.
                 */
                ...prior.slice(-RELAY_CONTEXT_MESSAGES),
                { id: `handoff-${runId}`, role: "user", content: message },
              ]
            : [
                /*
                 * A forward hop gets the conversation INSIDE the ask, attributed, and never as turns
                 * of its own. Every word in it was said to the asking Bot: handed over as this Bot's
                 * own history, the person's "ask Knowledge, do not answer it yourself" is an
                 * instruction to Knowledge not to answer, and the asking Bot's replies are things
                 * Knowledge remembers saying.
                 */
                {
                  id: `handoff-${runId}`,
                  role: "user",
                  content: inConversation(prior, work, message),
                },
              ];
        agent.threadId = where.threadId;
        // The platform's own message type rather than AG-UI's, which is what `history` returns: the
        // two agree where it matters, and converting between them is a place to lose a message.
        agent.setMessages(asked as Parameters<AbstractAgent["setMessages"]>[0]);
        /*
         * Renewed while the addressed Bot works, because the lock expires on its own. A run is minutes
         * and the platform's window is short; a lock that lapses mid-answer lets a second run into the
         * conversation, which is the thing it exists to prevent.
         *
         * A renewal refused as a conflict means somebody else now holds this conversation — on a
         * relay, most likely the person, having typed in their own channel. The run is stopped as a
         * pause would stop it and the hop fails into a retry, rather than writing this Bot's answer
         * into their run. A renewal that merely failed is skipped; see `keepLease`.
         */
        const lockLost = new AbortController();
        const heartbeat = keepLease({
          renew: () => lock.renew({ threadId: where.threadId, runId }),
          everyMs: renewEveryMs,
          lifetimeMs: lockLifetimeMs,
          onLost: (error) => lockLost.abort(error),
        });

        let stoppingHere = false;
        const knownStop = () => {
          void options
            .onKnownStop?.(work.actorId, runId, "cancelled")
            .catch(() => {
              console.warn(
                JSON.stringify({
                  type: "product-telemetry",
                  reason: "stop_observation_failed",
                }),
              );
            });
        };
        observeDetachedRun(agent, () => stoppingHere, knownStop);
        const recordStop = options.recordStopFor?.(
          {
            threadId: where.threadId,
            runId,
            userId: work.actorId,
            agentId: work.toBotId,
          },
          () => !lockLost.signal.aborted,
        );
        try {
          await settled(
            runner.run({
              ...(recordStop ? { recordStop } : {}),
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
              input: await (
                options.prepareRunInput ?? (async (input) => input)
              )(
                {
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
                work,
              ),
            }),
            deadlineMs,
            AbortSignal.any([paused, lockLost.signal]),
            () => {
              stoppingHere = true;
              // A pause is a cancel. A lost lock is a failure, and is not reported as a stop.
              if (!lockLost.signal.aborted) knownStop();
              return runner
                .stop?.({ threadId: where.threadId, runId })
                .catch(() => undefined);
            },
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
              ...(spoken ? { answeredBy: work.fromBotId } : {}),
            }).catch(() => {
              // The turn happened. A roster that has not caught up is worth less than a hop reported
              // as failed and run a second time.
            });
          }
        } finally {
          heartbeat.stop();
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
 * The ask, with the conversation it was asked from set out above it as context.
 *
 * Each turn says who said it, because none of it was said to the Bot reading it: the person was
 * talking to the asking Bot, and the asking Bot's replies are its own. The ask comes last, so the
 * most recent thing the model reads is what it is being asked to do, not the person's instruction
 * to somebody else.
 *
 * A turn's text is quoted; anything else in it (an image the person attached) is passed on as it
 * was, after the line it belongs to, so the Bot still sees what the person showed. Plain text when
 * there is nothing but text, which is every conversation without an attachment.
 */
function inConversation(
  prior: readonly unknown[],
  work: HandoffWork,
  message: string,
): string | unknown[] {
  if (prior.length === 0) return message;
  const asker = work.fromName ?? work.fromBotId;
  const self = work.toName ?? work.toBotId;
  const parts: unknown[] = [
    {
      type: "text",
      text: `The conversation so far, between the person and ${asker}, for context. The person was talking to ${asker}, not to you: where it asks for ${self}, that is the request below, and you are the one answering it.`,
    },
  ];
  for (const turn of prior) {
    const { role, content } = turn as { role?: unknown; content?: unknown };
    const speaker = role === "user" ? "The person" : asker;
    parts.push({ type: "text", text: `${speaker}: ${textOf(content)}` });
    if (Array.isArray(content)) {
      for (const part of content) {
        if (
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type !== "text"
        )
          parts.push(part);
      }
    }
  }
  parts.push({ type: "text", text: message });
  return parts.every((part) => (part as { type?: unknown }).type === "text")
    ? parts.map((part) => (part as { text: string }).text).join("\n\n")
    : parts;
}

/**
 * The Bot that was asked, saying the answer it already gave, in the conversation that asked.
 *
 * An agent that calls no model: it emits one assistant message with the answer in it and stops.
 * Run through the same runner, lock and recorder as any turn, so the message is a recorded part of
 * the thread — in its history, in the next run's context, and in a reload — rather than a row
 * written past the platform. The id names the Bot that said it, which is how the transcript draws
 * it under that Bot's name; AG-UI's `name` says the same for any reader that keeps it.
 */
class SpokenAnswer extends AbstractAgent {
  constructor(
    private readonly answer: { botId: string; name: string; text: string },
  ) {
    super();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const messageId = answerMessageId(this.answer.botId, input.runId);
    return from([
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
        name: this.answer.name,
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: this.answer.text,
      },
      { type: EventType.TEXT_MESSAGE_END, messageId },
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      },
    ] as BaseEvent[]);
  }
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
 * How long a hop waits for its conversation to be free before going back on the queue.
 *
 * Sized for the common case, the Bot that asked finishing its own reply, with room to spare. Not
 * longer, because this replica delivers its hops one at a time and a hop waiting here holds up the
 * next; a conversation busy for longer than this is a person's own run, and the queue's retry is
 * the right wait for that.
 */
const BUSY_WAIT_MS = 30_000;
/** The first look again, doubled each time up to the second figure. */
const BUSY_RETRY_FIRST_MS = 250;
const BUSY_RETRY_MAX_MS = 2_000;

/**
 * The lock, taken as soon as the conversation is free, or null if it is still busy after `waitMs`.
 *
 * Gives up at once, with the pause's own reason, when the person pauses the Bot while it waits: the
 * same way a paused run ends.
 */
async function acquireWhenFree(
  acquire: () => Promise<{ runId: string } | null>,
  waitMs: number,
  paused: AbortSignal,
): Promise<{ runId: string } | null> {
  const giveUpAt = Date.now() + waitMs;
  let delayMs = BUSY_RETRY_FIRST_MS;
  for (;;) {
    paused.throwIfAborted();
    const held = await acquire();
    if (held) return held;
    const left = giveUpAt - Date.now();
    if (left <= 0) return null;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        paused.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(delayMs, left));
      paused.addEventListener("abort", done, { once: true });
    });
    delayMs = Math.min(delayMs * 2, BUSY_RETRY_MAX_MS);
  }
}

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
  /**
   * Aborts when the person pauses the Bot or the conversation's lock is lost; the run is stopped and
   * the hop fails with the reason.
   */
  paused: AbortSignal,
  /** Stop the run; settles once the runner has closed it on the platform. */
  stop: () => Promise<unknown> | undefined,
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
    /*
     * Let go of the run only once the runner has closed it. Torn down first, a stopped run never
     * sends its terminal event, and the platform holds it open with no outcome. The deadline below
     * still bounds the wait.
     */
    let stopping = false;
    const onPause = () => {
      stopping = true;
      void Promise.resolve(stop()).finally(() =>
        finish(() => reject(paused.reason)),
      );
    };
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      paused.removeEventListener("abort", onPause);
      subscription?.unsubscribe();
      settle();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(timedOut())));
    }, deadlineMs);
    if (paused.aborted) {
      onPause();
      return;
    }
    paused.addEventListener("abort", onPause, { once: true });
    subscription = events.subscribe({
      next: (event) => {
        if (event.type === EventType.RUN_ERROR) {
          failure = new Error(
            (event as { message?: string }).message ??
              "the run ended in an error",
          );
        }
      },
      // A run that ends because it was stopped is the pause's outcome, not an answer.
      error: (error: unknown) =>
        finish(() =>
          stopping
            ? reject(paused.reason)
            : reject(error instanceof Error ? error : new Error(String(error))),
        ),
      complete: () =>
        finish(() =>
          stopping
            ? reject(paused.reason)
            : failure
              ? reject(failure)
              : resolve(),
        ),
    });
    // The stream that finished inside `subscribe`: `finish` had nothing to unsubscribe from at the
    // time, and the subscription it could not reach is this one.
    if (done) subscription.unsubscribe();
  });
}
