/**
 * One headless turn, run into the Intelligence thread the person will open.
 *
 * WRITTEN AGAINST `@copilotkit/runtime` 1.69.0, MIRRORING
 * `node_modules/@copilotkit/runtime/dist/v2/runtime/core/channel-manager.mjs:189-316`
 * (`runCanonicalChannelAgent`, the package's own module-private headless-turn engine) and
 * `dist/v2/runtime/handlers/intelligence/run.mjs:114-127` for `persistedInputMessages`. That engine is
 * not exported, so this is a hand copy of it with one addition — `getOrCreateThread` first — and it
 * has to be re-read against the package whenever the runtime is upgraded.
 *
 * WHY NOT A SECOND MOUNTED HANDLER. A loopback that mounts a second `mountCopilotRuntime` and POSTs
 * to its own run route is viable on identity grounds: `identifyUser` and `identifyActor` are both
 * injectable there (`copilot.ts:915-916`), so a routine's request could assert its owner without a
 * header. It was rejected on information, not on identity. The run route answers at gateway-JOIN
 * rather than at completion (`run.mjs:229-247` returns `{threadId, runId, joinToken, realtime}` as
 * soon as the runner has joined), so a caller learns that a turn STARTED and nothing else: no
 * completion signal, no reply text, and no failure. Recovering either would need a second transport —
 * a websocket back into the gateway — which is strictly more moving parts for strictly less
 * information than driving the runner in-process.
 *
 * WHAT WE ARE REACHING INTO. Five `ɵ`-prefixed methods: `ɵgetRunnerWsUrl` and `ɵgetRunnerAuthToken`
 * (at wiring time, in `index.ts`), and `ɵacquireThreadLock`, `ɵrenewThreadLock`,
 * `ɵcleanupThreadLock` here. They typecheck today and are how the package's own handlers do this, but
 * the `ɵ` prefix is the package saying it may change them without a major. Their request and response
 * interfaces — `AcquireThreadLockRequest`, `RenewThreadLockRequest`, `CleanupThreadLockRequest` — are
 * declared in `dist/v2/runtime/intelligence-platform/client.d.mts:339-367` and are NOT exported from
 * `@copilotkit/runtime/v2`, so the shapes in `IntelligenceLike` below are RESTATED BY HAND. Nothing
 * fails loudly when the package changes them: a renamed field would typecheck against our own
 * restatement and be silently dropped on the wire. That is what the test file is for.
 *
 * THE LOCK LIFECYCLE IS NOW OURS TO KEEP CORRECT. In the browser path the runtime holds the lock and
 * releases it; here we do. A bug in it is not a failed routine, it is a thread the person cannot chat
 * in — see the `finally` block, which is the single most important thing in this file.
 *
 * GATEWAY AVAILABILITY IS NOW ON THE CRON RUN'S CRITICAL PATH. Driving the runner means the turn goes
 * through the Intelligence gateway's Phoenix channel: it can answer `CHANNEL_JOIN_ERROR` or time out
 * joining (`runner/intelligence.mjs:194-229`), and events must be durably acknowledged within
 * `EVENT_DURABILITY_DEADLINE_MS = 60_000` (`intelligence.mjs:16, 505-511`) or the run fails. So a
 * routine firing during an Intelligence incident fails HERE, where a turn that only called the model
 * and never persisted anything would have succeeded. That trade was made deliberately: a reply nobody
 * can find in the channel is not a reply, and the transcript is the whole point of a routine.
 *
 * WHY A SECOND RUNNER INSTANCE IS SAFE. The thread lock is a platform resource, not a process one —
 * `POST /api/threads/:id/lock`, Redis-backed, keyed by thread — so a lock taken by this runner is seen
 * by the runtime's runner and by every other replica. `IntelligenceAgentRunner.threads` is a local
 * fast path (`intelligence.mjs:105`, "Thread already running") and nothing else, which is why the
 * runner is built ONCE at wiring time and reused: one instance per turn would fragment that map, and
 * two concurrent turns on one thread would then race past the local check and collide at the platform
 * lock instead of failing cheaply here.
 */
import type {
  AbstractAgent,
  BaseEvent,
  Message,
  RunAgentInput,
} from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { sanitizeSeededHistory } from "../agents/history-sanitize";
import { historyOrEmpty } from "../copilot";
import type { TurnRunner } from "./runner";

/**
 * The gap between stopping a turn and giving up on it.
 *
 * `abortRun` on `RunSelectedAgent` reaches the agent the run turned into, and that agent does not
 * exist until `build()` resolves (`copilot.ts:649, 664-673`): during that window the wrapper has no
 * `inner`, so abort is a no-op and the deadline cannot actually stop anything. This is the backstop
 * that settles the promise anyway, so a firing cannot hang for ever on a build that never finishes.
 *
 * Injectable only so the test can exercise the backstop without waiting five real seconds for it.
 */
const DEFAULT_ABORT_GRACE_MS = 5_000;

/** How long one headless turn may take before it is stopped. */
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;

/**
 * The lock TTL and how often it is renewed.
 *
 * The same relationship the runtime's own handler uses: renew comfortably inside the TTL so one slow
 * request does not drop a lock we still hold. The TTL matters to a person: while it is held, their
 * browser's next message is refused with 409 "Thread lock denied" (`run.mjs:91`), so a lock leaked by
 * a failed routine locks them out of their own conversation for exactly this long.
 */
const DEFAULT_LOCK_TTL_SECONDS = 20;
const DEFAULT_HEARTBEAT_MS = 15_000;

/**
 * One row of Intelligence history, as `ThreadMessagesResponse` declares it
 * (`client.d.mts:280-302`). Restated because it is not exported.
 */
type ThreadHistoryMessage = {
  id: string;
  role: string;
  content?: unknown;
  activityType?: string;
  toolCalls?: { id: string; name: string; args: string }[];
  toolCallId?: string;
};

/**
 * The platform client, named by the methods this file calls and nothing else.
 *
 * Narrow and structural on purpose. It is what lets the tests drive every exit path without a
 * gateway, and it is the honest documentation of how much of `CopilotKitIntelligence` a headless turn
 * depends on. The real client satisfies it; see the seam note above about the `ɵ` shapes being
 * restatements rather than imports.
 */
export type IntelligenceLike = {
  getOrCreateThread(params: {
    threadId: string;
    userId: string;
    agentId: string;
  }): Promise<unknown>;
  getThreadMessages(params: {
    threadId: string;
    userId: string;
  }): Promise<{ messages: ThreadHistoryMessage[] }>;
  ɵacquireThreadLock(params: {
    threadId: string;
    runId: string;
    userId: string;
    agentId: string;
    ttlSeconds?: number;
  }): Promise<unknown>;
  /** NOTE: no `userId` and no `agentId` — renew is identified by the thread and the run alone. */
  ɵrenewThreadLock(params: {
    threadId: string;
    runId: string;
    ttlSeconds: number;
  }): Promise<unknown>;
  ɵcleanupThreadLock(params: {
    threadId: string;
    runId: string;
  }): Promise<void>;
};

/**
 * What we subscribe to. Declared rather than imported as `Observable<BaseEvent>` so a fake is a plain
 * object; the real observable satisfies it.
 */
type EventStream = {
  subscribe(observer: {
    next: (event: BaseEvent) => void;
    error: (error: unknown) => void;
    complete: () => void;
  }): unknown;
};

/** The `IntelligenceAgentRunner`, named by the two methods this file calls. */
export type RunnerLike = {
  run(request: {
    threadId: string;
    agent: AbstractAgent;
    input: RunAgentInput;
    persistedInputMessages?: Message[];
  }): EventStream;
  stop(request: {
    threadId: string;
    runId?: string;
  }): Promise<boolean | undefined>;
};

/**
 * Convert one canonical Intelligence row into an AG-UI message.
 *
 * The shape at `channel-manager.mjs:337-353`, minus the managed-asset hydration that only a Slack or
 * Teams attachment needs. `content ?? ""` because the platform omits content on a tool-call-only
 * assistant row and AG-UI requires the field; `toolCalls` are re-nested into AG-UI's
 * `{ id, type: "function", function: { name, arguments } }`; `toolCallId` is carried so a tool result
 * in history still points at the call it answers.
 *
 * Rows with `role: "activity"` are seeded as they are. `prepareRunAgentInput` filters them out of the
 * input it hands the agent (`@ag-ui/client` 0.0.57), so there is no filter to write here.
 *
 * Cast at the end because the platform types `role` as `string` and `content` as `unknown`, while
 * `Message` is a union discriminated on `role`. There is nothing to narrow against at this boundary:
 * the platform is the authority on its own history.
 */
function toAgentMessage(message: ThreadHistoryMessage): Message {
  return {
    id: message.id,
    role: message.role,
    content: message.content ?? "",
    ...(message.activityType ? { activityType: message.activityType } : {}),
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.args },
          })),
        }
      : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
  } as Message;
}

/**
 * Re-exported from `agents/history-sanitize.ts`, where it now lives, because a chat turn needs
 * it too and this module cannot be imported from `copilot.ts`, since the import already runs the
 * other way. Kept as a name on this module because this is where the reasoning was found and where the
 * tests that cover the seeding path still reach for it.
 */
export { sanitizeSeededHistory };

/** What a message said out loud, or nothing if it did not say anything. */
function assistantText(message: Message): string | undefined {
  if (message.role !== "assistant") return undefined;
  const { content } = message;
  return typeof content === "string" && content.length > 0
    ? content
    : undefined;
}

/**
 * The stored instruction, wrapped in the sentences that tell the turn it IS a firing.
 *
 * FOUND ON A LIVE FIRING, and it recorded `succeeded`. The instruction read "Every run, append the
 * current date and time as a new bulleted list item to the Notion page …" and was sent to the model
 * verbatim as the turn's user message. The model read it as a question about routine MANAGEMENT
 * rather than as work: it called `list_routines`, found a routine that already said exactly that,
 * answered that it was already configured, and appended nothing. Nothing failed, so nothing was
 * reported — a routine telling somebody it is working while doing nothing at all, which is worse than
 * one that breaks.
 *
 * And the model was not being stupid. Instructions are WRITTEN in schedule-speak — "every run",
 * "every 15 minutes", "each morning" — because that is how a person asks for a standing thing, and
 * schedule-shaped prose arriving out of nowhere reads as a request to SET UP a schedule. The most
 * plausible reading of its own routine's text was "check whether this is set up"; it was, so it did
 * nothing, successfully. No wording of the stored instruction fixes that on its own, because the
 * sentence a person writes is the sentence that describes the schedule.
 *
 * So the frame says the three things the instruction cannot say about itself: that this is a
 * scheduled firing happening now, that the work belongs in this turn, and that managing routines is
 * not what was asked. It is PRESENTATION — which is why it lives here and not in the stored row or in
 * {@link TurnRunner}'s signature: the row keeps what the person asked for, and this is how it is put
 * to the model.
 *
 * ONLY THE NEW MESSAGE IS FRAMED, and that matters twice. The framed text is what
 * `persistedInputMessages` writes to the transcript — correctly, since the transcript should show
 * what the turn was actually asked — so it comes back as HISTORY on the next firing. History is
 * converted and seeded exactly as the platform handed it over and nothing re-frames it; a test holds
 * that, because the alternative is a message that grows a fresh paragraph of frame every night.
 */
export function frameFiring(instruction: string): string {
  return [
    "One of your routines is firing right now, on its schedule, and this is that firing.",
    "Carry out the instruction below in this turn: do the work now, then say what happened.",
    "Do not create, list or change any routine unless the instruction itself asks you to.",
    "",
    instruction,
  ].join("\n");
}

export function createTurnRunner(options: {
  intelligence: IntelligenceLike;
  runner: RunnerLike;
  /** The owner's coworkers, resolved as the owner. Built per turn, keyed by registry id. */
  buildAgentFor: (input: {
    ownerUserId: string;
    agentId: string;
  }) => Promise<AbstractAgent>;
  /** How long one headless turn may take before it is stopped. */
  turnTimeoutMs?: number;
  lockTtlSeconds?: number;
  heartbeatMs?: number;
  /** See {@link DEFAULT_ABORT_GRACE_MS}. */
  abortGraceMs?: number;
}): TurnRunner {
  const {
    intelligence,
    runner,
    buildAgentFor,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    lockTtlSeconds = DEFAULT_LOCK_TTL_SECONDS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    abortGraceMs = DEFAULT_ABORT_GRACE_MS,
  } = options;

  return async ({ ownerUserId, agentId, threadId, instruction }) => {
    /*
     * One id for this turn, minted once.
     *
     * The same value goes to the lock acquire, to every renew, to `runner.stop`, and to the cleanup.
     * `ɵacquireThreadLock` does echo back a canonical `threadId` and `runId` — and the Channels path
     * adopts them, because a Slack thread id is not a platform one — but ours already IS the canonical
     * pair: the thread was just created through `getOrCreateThread` below, and the run id is minted
     * here and nowhere else. Re-minting or re-reading it is how a renew keeps a different lock alive
     * than the one the cleanup releases.
     */
    const runId = crypto.randomUUID();

    /*
     * THE ONE ADDITION over `runCanonicalChannelAgent`.
     *
     * A routine may be the very first thing to touch this (person, channel) thread. In the browser
     * path the thread is created by the first message anybody sends; here there is no browser, and
     * every call below — history, the lock, the run — is about a thread the platform has never heard
     * of. `getOrCreateThread` is public API, idempotent, and already handles the 409 create-race
     * (`client.d.mts:603-621`), so it is safe on the thousandth firing as well as the first.
     */
    await intelligence.getOrCreateThread({
      threadId,
      userId: ownerUserId,
      agentId,
    });

    /*
     * History, seeded by us because nobody else will.
     *
     * The browser path takes history from the request body (`handle-run.mjs:44`) and the Channels path
     * loads its own; a headless turn has neither, so a routine that did not do this would ask its Bot
     * the same question every night with no memory of the last answer. `historyOrEmpty` is the
     * 404-on-a-fresh-thread case: `getOrCreateThread` above makes that rare, not impossible, since a
     * concurrent delete is still a thing that can happen between the two calls.
     *
     * And sanitized on the way in — see {@link sanitizeSeededHistory}, which is the difference
     * between a routine that survives one interrupted chat turn and one that never fires again.
     */
    const history = await historyOrEmpty(
      () => intelligence.getThreadMessages({ threadId, userId: ownerUserId }),
      { messages: [] as ThreadHistoryMessage[] },
    );

    const seeded = sanitizeSeededHistory(history.messages.map(toAgentMessage));
    /*
     * This turn's own message — and the ONLY message that is framed. See {@link frameFiring} for the
     * firing it did nothing on. The seeded history above is untouched, which is what keeps a previous
     * firing's framed message (it persisted, so it is back here as history) from being framed twice.
     */
    const turn = {
      id: crypto.randomUUID(),
      role: "user",
      content: frameFiring(instruction),
    } as Message;
    const messages = [...seeded, turn];

    /*
     * WHAT THIS RUN IS ALLOWED TO PERSIST, and it is mandatory.
     *
     * `run.mjs:117-127`: the set subtraction on ids, not on positions. The runner defaults it to the
     * WHOLE input (`intelligence.mjs:283`), so omitting it re-persists every message in the thread on
     * every firing — a transcript that doubles in size every night until the person's channel is
     * unreadable.
     */
    const historicIds = new Set(history.messages.map((message) => message.id));
    const persistedInputMessages = messages.filter(
      (message) => !historicIds.has(message.id),
    );

    /*
     * The Bot, resolved as its owner, and pointed at this thread.
     *
     * `threadId` and the messages are assigned ON THE AGENT because that is where the runner reads
     * them from: it calls `agent.runAgent(input, …)` (`intelligence.mjs:309`) and `runAgent` rebuilds
     * its own `RunAgentInput` from `this.threadId`, `this.messages` and `this.state` through
     * `prepareRunAgentInput`, taking only `runId`, `tools`, `context` and `forwardedProps` from what
     * is passed. So an input object alone would run the right id against an empty conversation.
     *
     * `agent.run` is never called from here. The runner owns the run: it is what stamps canonical
     * ownership on every event and pushes them to the gateway, which is the whole reason this file
     * exists rather than a bare `runAgent`.
     */
    const agent = await buildAgentFor({ ownerUserId, agentId });
    agent.threadId = threadId;
    agent.setMessages(messages);

    const input: RunAgentInput = {
      threadId,
      runId,
      messages,
      state: agent.state,
      // Empty because a headless turn has no browser to register frontend tools. What the Bot itself
      // may call is decided where it is built, not here.
      tools: [],
      context: [],
      forwardedProps: undefined,
    };

    /*
     * The reply is recovered by diffing the agent, because the runner throws away what `runAgent`
     * returns (`intelligence.mjs:309` awaits it and discards the `RunAgentResult`), so `newMessages`
     * is unreachable from out here. This is the before-picture.
     */
    const before = new Set(agent.messages.map((message) => message.id));
    const chunks: string[] = [];
    const spoken = agent.subscribe({
      onTextMessageEndEvent: ({ textMessageBuffer }) => {
        if (textMessageBuffer.length > 0) chunks.push(textMessageBuffer);
      },
    });

    await intelligence.ɵacquireThreadLock({
      threadId,
      runId,
      userId: ownerUserId,
      agentId,
      ttlSeconds: lockTtlSeconds,
    });

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    let heartbeatError: unknown;
    /** Whether the deadline stopped this turn. See the throw below the `finally`. */
    let stopped = false;
    /**
     * `stopCanonicalRun`'s shape (`channel-manager.mjs:222-229`): one promise for the whole turn,
     * not one per caller. Both the heartbeat-reject path and the deadline path call `stopTurn`, and
     * without the `??=` each would issue its own `runner.stop`, which is two stops racing each other
     * for one run id. The seam note above about the acquire echo applies here too: if this file ever
     * adopts the acquired `threadId`/`runId` instead of minting its own, it must guard the echo the
     * way `run.mjs:94` does — `lock.threadId || threadId` — before trusting it, not use it bare.
     */
    let stopPromise: Promise<boolean | undefined> | undefined;

    const clearHeartbeat = () => {
      if (heartbeat === undefined) return;
      clearInterval(heartbeat);
      heartbeat = undefined;
    };

    /** Stop this exact run, both ends: the agent's own abort and the runner's stop flag. */
    const stopTurn = () => {
      try {
        agent.abortRun();
      } catch {
        // An agent that cannot be aborted must not stop us telling the runner to give up. The
        // reason it refused is not actionable here and `runner.stop` is the half that matters:
        // it sets `stopRequested`, which is what makes `finalizeRunEvents` close the run as
        // stopped rather than leaving it open for ever on the platform.
      }
      stopPromise ??= runner.stop({ threadId, runId }).catch(() => undefined);
    };

    heartbeat = setInterval(() => {
      void intelligence
        .ɵrenewThreadLock({ threadId, runId, ttlSeconds: lockTtlSeconds })
        .catch((error: unknown) => {
          if (heartbeat === undefined) return;
          /*
           * A lock we no longer hold means somebody else is in this thread — the person, most
           * likely, having just typed something. Continuing would write this turn's events into
           * their run, so the turn is stopped and the failure is raised rather than recovered.
           */
          clearHeartbeat();
          heartbeatError = error;
          stopTurn();
        });
    }, heartbeatMs);
    // So a heartbeat that is still pending cannot hold a one-shot process open.
    heartbeat.unref?.();

    try {
      const completed = new Promise<void>((resolve, reject) => {
        let terminal: Error | undefined;
        runner
          .run({ threadId, agent, input, persistedInputMessages })
          .subscribe({
            /*
             * RUN_ERROR THROUGH `next` IS TERMINAL. The Intelligence runner reports a failed run by
             * emitting RUN_ERROR and then COMPLETING the observable (`intelligence.mjs:317-340`) —
             * `error` is only for a socket or durability failure. A RUN_ERROR not caught here would
             * therefore arrive as a successful completion, and the turn would look like a Bot that
             * answered with nothing.
             */
            next: (event) => {
              if (event.type !== EventType.RUN_ERROR || terminal) return;
              const message =
                "message" in event && typeof event.message === "string"
                  ? event.message
                  : "The routine's turn failed.";
              terminal = new Error(message);
              terminal.name = "RoutineTurnRunError";
            },
            error: reject,
            complete: () => {
              if (terminal) reject(terminal);
              else resolve();
            },
          });
      });

      const timeout = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          stopped = true;
          stopTurn();
        }, turnTimeoutMs);
        deadline.unref?.();
        backstop = setTimeout(() => {
          reject(
            new Error(
              `The routine's turn did not finish within ${Math.round(turnTimeoutMs / 1000)}s and could not be stopped.`,
            ),
          );
        }, turnTimeoutMs + abortGraceMs);
        backstop.unref?.();
      });

      await Promise.race([completed, timeout]);
    } finally {
      /*
       * THE SINGLE MOST IMPORTANT LINES IN THIS FILE, on every exit path — success, a thrown run, the
       * deadline, a failed heartbeat.
       *
       * While this lock is held, the person's next browser message is refused with 409 "Thread lock
       * denied" (`run.mjs:85-92`) for the whole TTL. A routine that fails quietly and leaks its lock
       * does not just fail: it locks somebody out of their own conversation, at three in the morning,
       * for a reason no screen explains. `.catch` because a cleanup that cannot be reached must not
       * replace the real failure with a second one — the TTL is the backstop for that case.
       */
      clearHeartbeat();
      if (deadline !== undefined) clearTimeout(deadline);
      if (backstop !== undefined) clearTimeout(backstop);
      spoken.unsubscribe();
      await intelligence
        .ɵcleanupThreadLock({ threadId, runId })
        .catch(() => undefined);
    }

    // Raised after the lock is released, and ahead of any reply: a turn that lost its lock partway
    // through is not a turn that answered, however much text it produced first. `stopPromise` is
    // awaited first — the reference's own order (`channel-manager.mjs:311-313`) — so a stop this
    // path itself requested has actually settled before we report on it, not just been requested.
    if (heartbeatError !== undefined) {
      await stopPromise;
      throw heartbeatError;
    }

    /*
     * And the same for a turn the deadline stopped, even when the abort worked and the run then
     * completed inside the grace window. A stopped run is a truncated one: whatever text it had
     * reached is half a sentence, and returning it here would post it into the channel as the answer
     * and close the firing as a success.
     */
    if (stopped) {
      await stopPromise;
      throw new Error(
        `The routine's turn was stopped after ${Math.round(turnTimeoutMs / 1000)}s.`,
      );
    }

    const said = agent.messages
      .filter((message) => !before.has(message.id))
      .map(assistantText)
      .filter((text): text is string => text !== undefined);
    // The diff first, the streamed chunks as the fallback: the diff is what was persisted, which is
    // what the person will read in the channel, and the chunks are only what went past.
    const replyText = (said.length > 0 ? said : chunks).join("\n\n");

    /*
     * An interrupt is an unfinished turn with nobody to ask, and it is checked BEFORE the empty-reply
     * case below. A turn that interrupted before saying anything has both conditions true at once,
     * and only one sentence can go on the run row and into the channel: "finished without saying
     * anything" would be a lie about a turn that in fact stopped to ask a question. The Bot stopped
     * to put a question to a person who is not there, so whatever it said first is half of an
     * exchange. Posting it as the answer would be the worst of the options: the routine would read as
     * successful and the channel would carry a reply that is waiting on something.
     */
    if (agent.pendingInterrupts.length > 0) {
      throw new Error(
        "The turn stopped to ask a question, and a routine has nobody to ask.",
      );
    }
    if (replyText.length === 0) {
      throw new Error("The turn finished without saying anything.");
    }

    return { replyText };
  };
}
