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
import { NOT_SHOWN } from "@openbot/shared/component-markers";
import { frameFiring } from "@openbot/shared/routine-firing";
import type { ApprovalContinuation } from "./continuation";
import {
  type HeadlessTool,
  HeadlessToolSuspension,
  HeadlessToolsMiddleware,
  type HeadlessWaiting,
  OPENBOT_WAITING_METADATA,
} from "./headless-tools";
import { sanitizeSeededHistory } from "./history-sanitize";
import type { AuditInitiator } from "./initiator";
import { keepLease } from "./lease";
import { TURN_LIMITS } from "./limits";
import type { ComponentCatalog, TurnAdmission } from "./ports";
import { historyOrEmpty } from "./thread-history";

/** Everything a headless turn needs, injectable so tests never dial a model. */
export type TurnRunner = (input: {
  ownerUserId: string; // the actor the run asserts — grants and connections resolve to them
  routineId: string; // what the trail names as having started this turn, rather than the owner
  agentId: string;
  threadId: string; // the owner's thread for the routine's channel
  instruction: string; // the user message of this turn
  initiator?: AuditInitiator;
  signal?: AbortSignal;
  continuation?: {
    snapshot: ApprovalContinuation;
    result: { content: string; error?: string };
    messageId: string;
  };
  userMessage?: Message;
  /** Durable inbound delivery id; reused by lock, runner and emitted events. */
  runId?: string;
  /** How deep in a Bot-to-Bot chain this turn is. Absent is a person's own turn, depth zero. */
  depth?: number;
  /** The reply so far, each time more of it arrives, for a surface that shows a turn in progress. */
  onText?: (text: string) => void;
}) => Promise<{ replyText: string; components?: DrawnComponent[] }>;

/** A display component the Bot drew in a turn and the server allowed, with the props it drew. */
export type DrawnComponent = { name: string; args: Record<string, unknown> };

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
    learningContainerId?: string;
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
    learningContainerId?: string;
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
 * Re-exported from `./history-sanitize.ts`, where it lives because a chat turn needs it too. Kept as
 * a name on this module because this is where the reasoning was found and where the tests that
 * cover the seeding path still reach for it.
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
 * The display components this turn drew, in order: a component call whose result is not a refusal.
 * A chat surface that cannot open the conversation (Teams, Slack) draws them from this.
 */
export function drawnComponents(
  messages: Message[],
  componentNames: ReadonlySet<string>,
): DrawnComponent[] {
  const results = new Map<string, string>();
  for (const message of messages)
    if (message.role === "tool" && typeof message.content === "string")
      results.set(message.toolCallId, message.content);
  const drawn: DrawnComponent[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (!componentNames.has(call.function.name)) continue;
      const result = results.get(call.id);
      if (result === undefined || result.startsWith(NOT_SHOWN)) continue;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        if (args && typeof args === "object" && !Array.isArray(args))
          drawn.push({ name: call.function.name, args });
      } catch {
        // A call whose arguments are not JSON was refused by the schema check, so nothing was drawn.
      }
    }
  }
  return drawn;
}

/*
 * The frame is declared in `shared/` because the transcript has to recognise it again — see
 * `readFiring` there. Imported AND re-exported, and it needs both: the turn runner below calls it to
 * build this turn's message, and `server/tests/routine-run-turn.test.ts:7` imports it from this
 * module, which is the right place for it to look because this is the module that decides a firing
 * is framed at all. A bare `export … from` would satisfy the test and leave the call site
 * unresolved.
 *
 * No line number for the call site on purpose. An intra-file reference shifts every time anything
 * above it grows or shrinks — deleting the doc comment this replaced moved that call by thirty
 * lines — so it would be stale on arrival. The cross-file citation above does not have that problem.
 */
export { frameFiring };

/**
 * What a turn is given, and what it may persist.
 *
 * `messages` is the conversation the run sees: the seeded history plus this turn's message, or, for a
 * continuation, the snapshot it stopped on plus the answer to the call it was waiting for.
 *
 * `persistedInputMessages` is WHAT THIS RUN IS ALLOWED TO PERSIST, and it is mandatory. `run.mjs:117-127`:
 * the set subtraction on ids, not on positions. The runner defaults it to the WHOLE input
 * (`intelligence.mjs:283`), so omitting it re-persists every message in the thread on every firing — a
 * transcript that doubles in size every night until the person's channel is unreadable.
 */
export function turnMessages(input: {
  /** The thread's history as the platform holds it, already converted and sanitized. */
  seeded: Message[];
  /** The ids of that history, before sanitizing, which is what the platform already holds. */
  historicIds: ReadonlySet<string>;
  /** This turn's own message; ignored for a continuation. */
  turn: Message;
  continuation?: Parameters<TurnRunner>[0]["continuation"];
}): { messages: Message[]; persistedInputMessages: Message[] } {
  const { seeded, historicIds, turn, continuation } = input;
  const messages: Message[] = continuation
    ? sanitizeSeededHistory([
        ...continuation.snapshot.messages,
        {
          id: continuation.messageId,
          role: "tool",
          toolCallId: continuation.snapshot.toolCallId,
          ...continuation.result,
        },
      ])
    : [...seeded, turn];
  return {
    messages,
    persistedInputMessages: messages.filter(
      (message) => !historicIds.has(message.id),
    ),
  };
}

/** The run's input: this run's id, the conversation, the tools it is offered, and any resume. */
export function turnInput(input: {
  threadId: string;
  runId: string;
  messages: Message[];
  state: unknown;
  tools: readonly HeadlessTool[];
  continuation?: Parameters<TurnRunner>[0]["continuation"];
}): RunAgentInput {
  const { threadId, runId, messages, state, tools, continuation } = input;
  return {
    threadId,
    runId,
    messages,
    state,
    tools: tools.filter((tool) => !tool.hidden).map((tool) => tool.definition),
    context: continuation?.snapshot.context ?? [],
    forwardedProps: continuation?.snapshot.forwardedProps,
    ...(continuation
      ? {
          resume: [
            {
              interruptId: continuation.snapshot.toolCallId,
              status: "resolved" as const,
              payload: continuation.result.content,
            },
          ],
        }
      : {}),
  };
}

/**
 * The thread's lock for one run, held until it is released.
 *
 * Acquired with this run's own id and renewed on a heartbeat with the same id, so the lock the
 * cleanup releases is the lock that was taken. A renew refused as a conflict means somebody else is
 * in this thread — the person, most likely, having just typed something — so the heartbeat stops
 * and `onLost` is told, once; the caller stops the turn rather than write its events into their
 * run. A renew that merely failed is skipped; see `keepLease`.
 *
 * This is a deliberate departure from the runtime's own channel runner (`channel-manager.mjs:257-273`),
 * which stops on any renewal error: a turn stopped by a network blip is retried from the start, and
 * a Bot that already sent an email sends it again.
 */
type Lease = {
  /** Stop renewing. Safe to call more than once. */
  stopHeartbeat: () => void;
  /** Give the lock back. Never rejects: the TTL is the backstop for a cleanup that cannot be reached. */
  release: () => Promise<void>;
};

async function takeLease(input: {
  intelligence: IntelligenceLike;
  threadId: string;
  runId: string;
  userId: string;
  agentId: string;
  ttlSeconds: number;
  learningContainerId?: string;
  heartbeatMs: number;
  onLost: (error: unknown) => void;
}): Promise<Lease> {
  const {
    intelligence,
    threadId,
    runId,
    userId,
    agentId,
    ttlSeconds,
    learningContainerId,
    heartbeatMs,
    onLost,
  } = input;
  await intelligence.ɵacquireThreadLock({
    threadId,
    runId,
    userId,
    agentId,
    ttlSeconds,
    ...(learningContainerId ? { learningContainerId } : {}),
  });

  const heartbeat = keepLease({
    renew: () => intelligence.ɵrenewThreadLock({ threadId, runId, ttlSeconds }),
    everyMs: heartbeatMs,
    lifetimeMs: ttlSeconds * 1000,
    onLost,
  });

  return {
    stopHeartbeat: heartbeat.stop,
    release: () =>
      intelligence
        .ɵcleanupThreadLock({ threadId, runId })
        .catch(() => undefined),
  };
}

/**
 * How a headless turn ended: exactly one of these per turn, decided by {@link settle} and turned into
 * a reply or an error only by {@link conclude}.
 */
export type TurnOutcome =
  /** The Bot answered. */
  | { kind: "completed"; replyText: string; components: DrawnComponent[] }
  /** The run itself failed: a RUN_ERROR, a broken stream, a cancellation, or a stop that never landed. */
  | { kind: "failed"; error: unknown }
  /** The thread's lock was lost partway through, so whatever the turn said is not an answer. */
  | { kind: "lockLost"; error: unknown }
  /** The deadline stopped the run; whatever it had said is half a sentence. */
  | { kind: "timedOut" }
  /** The turn is waiting on a person, with a durable request open. */
  | { kind: "suspended"; suspension: HeadlessToolSuspension }
  /** The turn stopped to ask a question with nobody there to answer it. */
  | { kind: "interrupted" }
  /** The run finished and said nothing. */
  | { kind: "empty" };

/** Everything a finished run left behind, which is all {@link settle} decides from. */
export type TurnEvidence = {
  /** Set when the run's own promise rejected; wrapped because the rejection itself may be anything. */
  failed?: { error: unknown };
  /** The renew failure that lost the lock, when one did. */
  heartbeatError?: unknown;
  /** Whether the deadline stopped the run. */
  stopped: boolean;
  /** The waiting the run announced through its `openbot.headless.waiting` event. */
  waiting?: HeadlessToolSuspension;
  /** The messages this run added to the agent. */
  added: Message[];
  /** What was streamed, for when nothing was added. */
  chunks: string[];
  pendingInterrupts: AbstractAgent["pendingInterrupts"];
  componentNames: ReadonlySet<string>;
};

/**
 * The one decision about how a turn ended, in this order and no other.
 *
 * A failure that escaped the run wins, because nothing after it was reached. Then a lost lock and the
 * deadline: a turn that lost its lock or was stopped is not a turn that answered, however much text it
 * produced first. Then a waiting, announced or carried on the interrupt, which names the request a
 * person still has to answer. Then a bare interrupt, checked BEFORE the empty reply: a turn that
 * interrupted before saying anything has both conditions true at once, and "finished without saying
 * anything" would be a lie about a turn that in fact stopped to ask a question.
 */
export function settle(evidence: TurnEvidence): TurnOutcome {
  if (evidence.failed) return { kind: "failed", error: evidence.failed.error };
  if (evidence.heartbeatError !== undefined)
    return { kind: "lockLost", error: evidence.heartbeatError };
  if (evidence.stopped) return { kind: "timedOut" };
  if (evidence.waiting)
    return { kind: "suspended", suspension: evidence.waiting };

  // The diff first, the streamed chunks as the fallback: the diff is what was persisted, which is
  // what the person will read in the channel, and the chunks are only what went past.
  const said = evidence.added
    .map(assistantText)
    .filter((text): text is string => text !== undefined);
  const replyText = (said.length > 0 ? said : evidence.chunks).join("\n\n");

  // The waiting details, when the CUSTOM event did not survive the trip, ride on the interrupt.
  const carried = evidence.pendingInterrupts
    .map((interrupt) => interrupt.metadata?.[OPENBOT_WAITING_METADATA])
    .find(
      (value): value is HeadlessWaiting & { message?: string } =>
        !!value &&
        typeof value === "object" &&
        typeof (value as { kind?: unknown }).kind === "string",
    );
  if (carried)
    return {
      kind: "suspended",
      suspension: new HeadlessToolSuspension(
        carried.message ?? "The turn is waiting for human input.",
        carried,
      ),
    };
  if (evidence.pendingInterrupts.length > 0) return { kind: "interrupted" };
  if (replyText.length === 0) return { kind: "empty" };
  return {
    kind: "completed",
    replyText,
    components: drawnComponents(evidence.added, evidence.componentNames),
  };
}

/**
 * The outcome as the caller receives it: a reply, or the error that names what happened.
 *
 * For a lost lock and a deadline, `stopped` is awaited first — the reference's own order
 * (`channel-manager.mjs:311-313`) — so a stop this turn itself requested has actually settled before
 * it is reported on, not just been requested.
 */
async function conclude(
  outcome: TurnOutcome,
  stopped: Promise<unknown> | undefined,
  turnTimeoutMs: number,
): Promise<{ replyText: string; components?: DrawnComponent[] }> {
  switch (outcome.kind) {
    case "failed":
      throw outcome.error;
    case "lockLost":
      await stopped;
      throw outcome.error;
    case "timedOut":
      await stopped;
      throw new Error(
        `The routine's turn was stopped after ${Math.round(turnTimeoutMs / 1000)}s.`,
      );
    case "suspended":
      throw outcome.suspension;
    case "interrupted":
      throw new Error(
        "The turn stopped to ask a question, and a routine has nobody to ask.",
      );
    case "empty":
      throw new Error("The turn finished without saying anything.");
    case "completed":
      return outcome.components.length > 0
        ? { replyText: outcome.replyText, components: outcome.components }
        : { replyText: outcome.replyText };
  }
}

export function createTurnRunner(options: {
  intelligence: IntelligenceLike;
  runner: RunnerLike;
  /** Checked before anything else; see `serverTurnAdmission` in agents/turn-admission.ts. */
  admission: TurnAdmission;
  learningContainerForThread?: (input: {
    threadId: string;
    agentId: string;
    userId: string;
  }) => Promise<string | undefined>;
  /** The owner's coworkers, resolved as the owner. Built per turn, keyed by registry id. */
  buildAgentFor: (input: {
    ownerUserId: string;
    agentId: string;
    initiator: AuditInitiator;
    depth?: number;
  }) => Promise<AbstractAgent>;
  toolsForTurn?: (input: {
    ownerUserId: string;
    agentId: string;
    initiator: AuditInitiator;
    threadId: string;
    runId: string;
  }) => Promise<HeadlessTool[]>;
  /**
   * The governed gallery, so a turn with no browser can still answer with a chart. Offered and
   * decided exactly as the browser would for this Bot. Absent, nothing is offered and nothing is
   * reported as drawn.
   */
  components?: ComponentCatalog;
  /** How long one headless turn may take before it is stopped. */
  turnTimeoutMs?: number;
  lockTtlSeconds?: number;
  heartbeatMs?: number;
  /** See `TURN_LIMITS.abortGraceMs`; injectable so a test need not wait five real seconds. */
  abortGraceMs?: number;
}): TurnRunner {
  const {
    intelligence,
    runner,
    admission,
    buildAgentFor,
    learningContainerForThread,
    toolsForTurn,
    components,
    turnTimeoutMs = TURN_LIMITS.turnTimeoutMs,
    lockTtlSeconds = TURN_LIMITS.lockTtlSeconds,
    heartbeatMs = TURN_LIMITS.heartbeatMs,
    abortGraceMs = TURN_LIMITS.abortGraceMs,
  } = options;

  return async ({
    ownerUserId,
    routineId,
    agentId,
    threadId,
    instruction,
    initiator: suppliedInitiator,
    continuation,
    signal,
    userMessage,
    runId: suppliedRunId,
    depth,
    onText,
  }) => {
    if (signal?.aborted) throw new Error("The headless turn was cancelled.");
    // A paused Bot or a refused capability throws here; a pause mid-turn aborts the returned signal.
    signal = await admission({ ownerUserId, agentId, signal });
    if (continuation && continuation.snapshot.threadId !== threadId)
      throw new Error(
        "The interrupted conversation does not match this thread.",
      );
    const initiator = suppliedInitiator ?? {
      kind: "routine" as const,
      id: routineId,
    };
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
    const runId = suppliedRunId ?? crypto.randomUUID();
    if (!runId.trim())
      throw new Error("The headless turn needs a non-empty run id.");

    /*
     * THE ONE ADDITION over `runCanonicalChannelAgent`.
     *
     * A routine may be the very first thing to touch this (person, channel) thread. In the browser
     * path the thread is created by the first message anybody sends; here there is no browser, and
     * every call below — history, the lock, the run — is about a thread the platform has never heard
     * of. `getOrCreateThread` is public API, idempotent, and already handles the 409 create-race
     * (`client.d.mts:603-621`), so it is safe on the thousandth firing as well as the first.
     */
    const learningContainerId = await learningContainerForThread?.({
      threadId,
      agentId,
      userId: ownerUserId,
    });
    await intelligence.getOrCreateThread({
      threadId,
      userId: ownerUserId,
      agentId,
      ...(learningContainerId ? { learningContainerId } : {}),
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
    const turn =
      userMessage ??
      ({
        id: crypto.randomUUID(),
        role: "user",
        content: frameFiring(instruction),
      } as Message);
    const { messages, persistedInputMessages } = turnMessages({
      seeded,
      historicIds: new Set(history.messages.map((message) => message.id)),
      turn,
      ...(continuation ? { continuation } : {}),
    });

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
    const agent = await buildAgentFor({
      ownerUserId,
      agentId,
      initiator,
      ...(depth ? { depth } : {}),
    });
    agent.threadId = threadId;
    agent.setMessages(messages);
    if (continuation) agent.setState(continuation.snapshot.state);
    const headlessTools = [
      ...((await toolsForTurn?.({
        ownerUserId,
        agentId,
        initiator,
        threadId,
        runId,
      })) ?? []),
      ...((await components?.toolsForTurn({
        agentId,
        ownerUserId,
        initiator,
      })) ?? []),
    ];
    if (headlessTools.length > 0)
      agent.use(new HeadlessToolsMiddleware(headlessTools, initiator));
    if (signal?.aborted) throw new Error("The headless turn was cancelled.");

    const input = turnInput({
      threadId,
      runId,
      messages,
      state: agent.state,
      tools: headlessTools,
      ...(continuation ? { continuation } : {}),
    });

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
      // The buffer is the message before this delta, so the delta is appended to report it.
      ...(onText
        ? {
            onTextMessageContentEvent: ({
              event,
              textMessageBuffer,
            }: {
              event: { delta: string };
              textMessageBuffer: string;
            }) => {
              onText(
                [...chunks, `${textMessageBuffer}${event.delta}`].join("\n\n"),
              );
            },
          }
        : {}),
    });

    let deadline: ReturnType<typeof setTimeout> | undefined;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    let heartbeatError: unknown;
    let waiting: HeadlessToolSuspension | undefined;
    /** Whether the deadline stopped this turn. See `settle`. */
    let stopped = false;
    /** Set when the run's promise rejected, so it can be reported after the lock is released. */
    let failed: { error: unknown } | undefined;
    /**
     * `stopCanonicalRun`'s shape (`channel-manager.mjs:222-229`): one promise for the whole turn,
     * not one per caller. Both the heartbeat-reject path and the deadline path call `stopTurn`, and
     * without the `??=` each would issue its own `runner.stop`, which is two stops racing each other
     * for one run id. The seam note above about the acquire echo applies here too: if this file ever
     * adopts the acquired `threadId`/`runId` instead of minting its own, it must guard the echo the
     * way `run.mjs:94` does — `lock.threadId || threadId` — before trusting it, not use it bare.
     */
    let stopPromise: Promise<boolean | undefined> | undefined;
    let cancelTurn: (() => void) | undefined;

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

    const lease = await takeLease({
      intelligence,
      threadId,
      runId,
      userId: ownerUserId,
      agentId,
      ttlSeconds: lockTtlSeconds,
      ...(learningContainerId ? { learningContainerId } : {}),
      heartbeatMs,
      /*
       * A lock we no longer hold means somebody else is in this thread — the person, most likely,
       * having just typed something. Continuing would write this turn's events into their run, so
       * the turn is stopped and the failure is raised rather than recovered.
       */
      onLost: (error) => {
        heartbeatError = error;
        stopTurn();
      },
    });

    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancelTurn = () => {
          stopTurn();
          reject(new Error("The headless turn was cancelled."));
        };
        signal?.addEventListener("abort", cancelTurn, { once: true });
        if (signal?.aborted) cancelTurn();
      });
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
              if (
                event.type === EventType.CUSTOM &&
                event.name === "openbot.headless.waiting"
              ) {
                const value = event.value as HeadlessWaiting & {
                  message?: string;
                };
                waiting = new HeadlessToolSuspension(
                  value.message ?? "The turn is waiting for human input.",
                  value,
                );
              }
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

      await Promise.race([completed, timeout, cancelled]);
    } catch (error) {
      failed = { error };
    } finally {
      /*
       * THE SINGLE MOST IMPORTANT LINES IN THIS FILE, on every exit path — success, a thrown run, the
       * deadline, a failed heartbeat.
       *
       * While this lock is held, the person's next browser message is refused with 409 "Thread lock
       * denied" (`run.mjs:85-92`) for the whole TTL. A routine that fails quietly and leaks its lock
       * does not just fail: it locks somebody out of their own conversation, at three in the morning,
       * for a reason no screen explains. `release` never rejects, because a cleanup that cannot be
       * reached must not replace the real failure with a second one — the TTL is the backstop for
       * that case.
       */
      lease.stopHeartbeat();
      if (cancelTurn) signal?.removeEventListener("abort", cancelTurn);
      if (signal?.aborted) await stopPromise;
      if (deadline !== undefined) clearTimeout(deadline);
      if (backstop !== undefined) clearTimeout(backstop);
      spoken.unsubscribe();
      await lease.release();
    }

    // Decided and reported only now, after the lock is released, on every path.
    const outcome = settle({
      ...(failed ? { failed } : {}),
      heartbeatError,
      stopped,
      ...(waiting ? { waiting } : {}),
      added: agent.messages.filter((message) => !before.has(message.id)),
      chunks,
      pendingInterrupts: agent.pendingInterrupts,
      componentNames: components?.names ?? new Set(),
    });
    return conclude(outcome, stopPromise, turnTimeoutMs);
  };
}
