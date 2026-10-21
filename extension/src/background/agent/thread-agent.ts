// One Thread of one agent in one tab, kept the way CopilotKit keeps it inside the page: an AG-UI agent (@ag-ui/client's
// AbstractAgent) whose runs are the runs the network capture observed, their events fed to it live. The library applies
// them exactly as it does for CopilotKit (chunk expansion, verification, message assembly, state patches, snapshots) and
// calls its subscribers at the same moments, so the agent events below fire when CopilotKit's do and carry what it
// carries. The subscriber is CopilotKit's (`@copilotkit/core`): its StateManager's bookkeeping of which run each message
// belongs to, then its LearningBridge's `agent.run`, `agent.message` and `tool.call`; after each, `agent.event` carries
// what those leave out of the AG-UI event (agent-event.ts).
//
// A frontend tool runs inside the page, where the network cannot see it; what CopilotKit reports of it is read off the
// traffic the way CopilotKit's own behaviour implies. Its RunHandler runs a tool the page offered in the run's `tools`
// once the run that called it has finished without a result for it (`tool.call` executing, at that RUN_FINISHED), one
// call at a time, and when the tool returns it puts the result into the Thread's history, which the page's next run
// request carries (`tool.call` completed, at that request, before the run it starts).
import {
  AbstractAgent,
  type AgentStateMutation,
  type AgentSubscriber,
  type BaseEvent,
  defaultApplyEvents,
  type Message,
  type RunAgentInput,
  randomUUID,
} from "@ag-ui/client";
import { type Observable, of, type ReplaySubject } from "rxjs";
import { map, tap } from "rxjs/operators";
import {
  type AgentEventPayload,
  createAgentEventBuilder,
  type Expressed,
} from "./agent-event";

type Json = AgentEventPayload;

/** Where this agent's events go: a CopilotKit event name, its value (undefined fields are left out, as JSON leaves them
 * out), and when the capture saw what caused it. */
export type ThreadAgentOutput = {
  emit(name: string, value: Record<string, unknown>, at: number): void;
  /** The library refused part of a run (a stream that breaks the AG-UI rules): what was left of it is dropped. */
  invalid(error: unknown): void;
};

/** One observed AG-UI event, as it is fed to the run, with when the capture saw it. */
export type FedEvent = { event: BaseEvent; at: number };

/** CopilotKit's agent in the page for one agent id, which every Thread of that agent in the page shares: the page keeps
 * one instance and moves it from Thread to Thread, so LearningBridge's `lastRunIds.get(agent)` (the run it gives a
 * message, a tool call or an error with no run of its own) carries over to the agent's next Thread. */
export type PageAgent = { lastRunId: string | undefined };

/** A run that continues an earlier one (CopilotKit's StateManager `markNextRunAsContinuation`): a frontend tool's
 * follow-up or the answer to an interrupt. Its messages belong to the run it continues. */
export type Continuation = { expectedRunId: string | undefined };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Text the person or the agent wrote, as LearningBridge reads it: only string content is text. */
const textOf = (message: Message): string =>
  typeof message.content === "string" ? message.content : "";

/** CopilotKit's FORWARDED_TO_CLIENT (tool-result-content.ts): a runtime's stand-in for a frontend tool's result, which
 * RunHandler does not count as one. */
const FORWARDED_TO_CLIENT = "Forwarded to client";

/** CopilotKit's normalizeToolResultContent: a tool result's text, or null when it has none. */
const resultText = (content: unknown): string | null => {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const text = content
      .flatMap((part) =>
        typeof part === "string"
          ? [part]
          : isRecord(part) && typeof part.text === "string"
            ? [part.text]
            : [],
      )
      .join("")
      .trim();
    return text.length > 0 ? text : null;
  }
  if (isRecord(content) && typeof content.text === "string")
    return content.text.trim();
  return null;
};

/** A tool's result in the history, as RunHandler counts one: never the runtime's stand-in. */
const isResultFor = (message: Message, toolCallId: string): boolean =>
  message.role === "tool" &&
  message.toolCallId === toolCallId &&
  resultText(message.content) !== FORWARDED_TO_CLIENT;

/** RunHandler.executeToolHandler: a tool that threw, or whose arguments did not parse, returns `Error: <message>`. */
const failed = (message: Message): boolean =>
  typeof message.content === "string" && message.content.startsWith("Error: ");

/** StateManager's `isContinuation`: an input that answers an interrupt, by the standard `resume` or a legacy command. */
const isContinuation = (
  input: Pick<RunAgentInput, "resume" | "forwardedProps">,
): boolean =>
  input.resume !== undefined ||
  Object.hasOwn(
    (input.forwardedProps as { command?: object } | undefined)?.command ?? {},
    "resume",
  );

export class ThreadAgent extends AbstractAgent {
  /** The live events of the run the library is about to apply; read by run() when its pipeline starts. */
  private next: ReplaySubject<FedEvent> | null = null;
  /** When the capture saw the event being fed right now, and so every event it expands into. */
  private feedAt = 0;
  private readonly seenAt = new WeakMap<object, number>();
  /** When the capture saw what is being applied right now: the time of everything emitted for it. */
  private at = 0;
  private continuation: Continuation | null = null;
  /** What the page sent for the run being applied, for a RUN_STARTED that does not echo its input. */
  private requestInput: unknown;
  private readonly builder: ReturnType<typeof createAgentEventBuilder>;

  // CopilotKit StateManager.subscribeToAgent, for this agent and Thread.
  private subRunId: string | undefined;
  private runFinished = false;
  private legacyInterrupted = false;
  private activeRun: string | undefined;
  private interrupted:
    | { runId: string; interruptIds: string[] | null }
    | undefined;
  private readonly messageRuns = new Map<string, string>();
  /** The run this Thread's events belong to: the run it started last, which `agent.event` names. */
  private lastRunId: string | undefined;
  // CopilotKit LearningBridge.toolCalls: the message and run each tool call came from.
  private readonly toolOrigins = new Map<
    string,
    { messageId: string | undefined; runId: string | undefined }
  >();
  // CopilotKit LearningBridge.executingTools: the frontend tool the page is running, from when.
  private readonly executingTools = new Map<
    string,
    { name: string; startedAt: number }
  >();
  /** Frontend tool calls a finished run left without a result, after the one running: RunHandler runs them in turn. */
  private waitingTools: { id: string; name: string }[] = [];
  /** When the run being applied finished (its RUN_FINISHED was seen); undefined while it has not. */
  private finishedAt: number | undefined;

  constructor(
    agentId: string | null,
    threadId: string,
    private readonly output: ThreadAgentOutput,
    expressed: Expressed,
    /** CopilotKit LearningBridge.lastRunIds, for the page's agent this Thread is one of. */
    private readonly page: PageAgent,
  ) {
    super({ threadId, ...(agentId === null ? {} : { agentId }) });
    this.builder = createAgentEventBuilder(expressed);
    this.subscribe(this.copilotKitSubscriber(this.builder));
  }

  /** The id the agent events carry for this agent: LearningBridge's `agent.agentId`. */
  get id(): string | null {
    return this.agentId ?? null;
  }

  /** Applies one run: its events arrive on `events` as the capture sees them, and the returned promise settles when the
   * library has applied the last of them (the run ended, or `events` completed short of its end). */
  async applyRun(
    events: ReplaySubject<FedEvent>,
    input: Pick<
      RunAgentInput,
      "runId" | "tools" | "context" | "forwardedProps" | "resume" | "state"
    >,
    continuation: Continuation | null,
    requestInput: unknown,
  ): Promise<void> {
    this.next = events;
    this.continuation = continuation;
    this.requestInput = requestInput;
    // The state the page ran with is the agent's, as CopilotKit's agent.state is what it sends.
    if (requestInput !== undefined && input.state !== undefined)
      this.state = structuredClone(input.state);
    // A run the page started was refused if it left interrupts unanswered: the page holds none of them any more.
    const answered = new Set(
      (input.resume ?? []).map((entry) => entry.interruptId),
    );
    if (this.pendingInterrupts.some((interrupt) => !answered.has(interrupt.id)))
      this.pendingInterrupts = [];
    this.finishedAt = undefined;
    const { newMessages } = await this.runAgent({
      runId: input.runId,
      tools: input.tools ?? [],
      context: input.context ?? [],
      forwardedProps: input.forwardedProps ?? {},
      ...(input.resume === undefined ? {} : { resume: input.resume }),
    });
    const finishedAt = this.finishedAt;
    this.finishedAt = undefined;
    // RunHandler.processAgentResult, once a run the page started has finished: the frontend tools it called and left
    // without a result run in the page.
    if (finishedAt !== undefined && requestInput !== undefined)
      this.runPageTools(newMessages, input.tools ?? [], finishedAt);
  }

  /** Whether the page is running a frontend tool call (LearningBridge.toolStatus's `executing`). */
  isExecuting(toolCallId: string): boolean {
    return this.executingTools.has(toolCallId);
  }

  /** The page is gone (its tab reached another document): the tools it was running there never finish. */
  pageGone(): void {
    this.executingTools.clear();
    this.waitingTools = [];
  }

  /** Messages the page added itself before a run, as CopilotKit adds them: the person's own through `addMessage` (an
   * `agent.message` each), anything else (a frontend tool's result) straight into the history, where the library reads
   * it but announces nothing. `at` is when the request carrying them was seen. */
  addFromPage(
    silent: { message: Message; after: string | null }[],
    typed: Message[],
    at: number,
  ): void {
    this.pageToolResults(
      silent.map(({ message }) => message),
      at,
    );
    for (const { message, after } of silent) {
      const index =
        after === null ? -1 : this.messages.findIndex((m) => m.id === after);
      this.messages.splice(index + 1, 0, message);
    }
    this.at = at;
    for (const message of typed) this.addMessage(message);
  }

  /** The recording ended: a merged delta still held goes out now. */
  flushHeld(): void {
    for (const pending of this.builder.flushAll()) this.emitPending(pending);
  }

  /** CopilotKit's run id for a message: the StateManager's, else the page agent's last run, whichever Thread it ran on
   * (LearningBridge.runIdForMessage): the person's first message in a new Thread names the previous Thread's last run. */
  runIdForMessage(messageId: string): string | null {
    return this.messageRuns.get(messageId) ?? this.page.lastRunId ?? null;
  }

  /** StateManager.getContinuationRunId: the interrupted run an input answers, without consuming it. */
  continuationRunIdFor(
    input: Pick<RunAgentInput, "resume" | "forwardedProps">,
  ): string | undefined {
    const pending = this.interrupted;
    if (!pending) return undefined;
    if (pending.interruptIds === null)
      return input.resume === undefined && isContinuation(input)
        ? pending.runId
        : undefined;
    const submitted = new Set(input.resume?.map((entry) => entry.interruptId));
    const matches =
      submitted.size > 0 &&
      submitted.size === input.resume?.length &&
      submitted.size === pending.interruptIds.length &&
      pending.interruptIds.every((id) => submitted.has(id));
    return matches ? pending.runId : undefined;
  }

  run(): Observable<BaseEvent> {
    const events = this.next;
    this.next = null;
    if (!events) return of();
    return events.pipe(
      map(({ event, at }) => {
        this.feedAt = at;
        return event;
      }),
    );
  }

  // Everything between run() and here is synchronous, so each event the library will apply is stamped with when the
  // capture saw the event it came from.
  protected override apply(
    input: RunAgentInput,
    events$: Observable<BaseEvent>,
    subscribers: AgentSubscriber[],
  ): Observable<AgentStateMutation> {
    return defaultApplyEvents(
      input,
      events$.pipe(tap((event) => this.seenAt.set(event, this.feedAt))),
      this,
      subscribers,
      this.debugLogger,
    );
  }

  // The library logs a refused stream as "Agent execution failed" and rethrows; here it is counted instead.
  protected override onError(
    _input: RunAgentInput,
    error: Error,
  ): Observable<AgentStateMutation> {
    this.output.invalid(error);
    return of({});
  }

  private emit(name: string, value: Record<string, unknown>): void {
    this.output.emit(name, value, this.at);
  }

  /** The frontend tool calls among a finished run's new messages that the page runs: a tool it offered in the run, a
   * call with no result in the history, not already running or waiting (RunHandler.processAgentResult). */
  private runPageTools(
    newMessages: Message[],
    tools: readonly { name: string }[],
    at: number,
  ): void {
    const offered = new Set(tools.map(({ name }) => name));
    for (const message of newMessages) {
      if (message.role !== "assistant") continue;
      for (const call of message.toolCalls ?? []) {
        if (
          !offered.has(call.function.name) ||
          this.executingTools.has(call.id) ||
          this.waitingTools.some(({ id }) => id === call.id) ||
          this.messages.some((other) => isResultFor(other, call.id))
        )
          continue;
        this.waitingTools.push({ id: call.id, name: call.function.name });
      }
    }
    this.nextPageTool(at);
  }

  /** The next waiting tool call starts once none is running (LearningBridge's `executing`). */
  private nextPageTool(at: number): void {
    if (this.executingTools.size > 0) return;
    const next = this.waitingTools.shift();
    if (!next) return;
    this.executingTools.set(next.id, { name: next.name, startedAt: at });
    this.emitToolCall("executing", next.id, next.name, {}, at);
  }

  /** The results the page put into the history, as its next run request carries them: each running tool call they
   * answer is completed (LearningBridge's `completed`), and the next waiting one starts. */
  private pageToolResults(messages: Message[], at: number): void {
    for (;;) {
      const running = this.executingTools.entries().next();
      if (running.done) return;
      const [id, { name, startedAt }] = running.value;
      const result = messages.find((message) => isResultFor(message, id));
      if (!result) return;
      this.executingTools.delete(id);
      this.emitToolCall(
        "completed",
        id,
        name,
        {
          durationMs: at - startedAt,
          outcome: failed(result) ? "error" : "ok",
        },
        at,
      );
      this.toolOrigins.delete(id);
      this.nextPageTool(at);
    }
  }

  /** LearningBridge.emitToolCall: the call's origin is where TOOL_CALL_START named it. */
  private emitToolCall(
    phase: "executing" | "completed",
    toolCallId: string,
    toolName: string,
    extra: { durationMs?: number; outcome?: "ok" | "error" },
    at: number,
  ): void {
    const origin = this.toolOrigins.get(toolCallId);
    this.output.emit(
      "tool.call",
      {
        phase,
        toolCallId,
        toolName,
        agentId: this.id,
        threadId: origin ? this.threadId : null,
        messageId: origin?.messageId,
        runId: origin?.runId,
        ...extra,
      },
      at,
    );
  }

  private copilotKitSubscriber(
    builder: ReturnType<typeof createAgentEventBuilder>,
  ): AgentSubscriber {
    /** What CopilotKit's events leave out of an AG-UI event, after them. */
    const extra = (payload: Json | null) => {
      if (payload === null) return;
      this.emit("agent.event", {
        threadId: this.threadId,
        runId: this.lastRunId,
        agentId: this.id,
        event: payload,
      });
    };
    const effective = (input: RunAgentInput) => this.subRunId ?? input.runId;
    return {
      onEvent: ({ event }) => {
        this.at = this.seenAt.get(event) ?? this.at;
        for (const pending of builder.flushBefore(event))
          this.emitPending(pending);
      },
      onRunStartedEvent: ({ event, input }) => {
        // StateManager
        const continuation = this.continuation;
        this.continuation = null;
        const started = event.input ?? { ...input, threadId: event.threadId };
        const resumedRunId = this.continuationRunIdFor(started);
        this.interrupted = undefined;
        this.legacyInterrupted = false;
        if (continuation)
          this.subRunId =
            continuation.expectedRunId ?? event.runId ?? input.runId;
        else if (resumedRunId) this.subRunId = resumedRunId;
        else if (
          this.runFinished &&
          input.runId === this.subRunId &&
          !isContinuation(input) &&
          (event.runId == null || event.runId === this.subRunId)
        )
          this.subRunId = randomUUID();
        else this.subRunId = event.runId || input.runId;
        this.runFinished = false;
        this.activeRun = effective(input);
        // LearningBridge
        this.lastRunId = event.runId;
        this.page.lastRunId = event.runId;
        this.emit("agent.run", {
          phase: "started",
          runId: event.runId,
          threadId: event.threadId,
          agentId: this.id,
        });
        extra(
          builder.rest(
            event.input === undefined && isRecord(this.requestInput)
              ? ({ ...event, input: this.requestInput } as BaseEvent)
              : event,
          ),
        );
      },
      onRunFinishedEvent: ({ event, input }) => {
        this.runFinished = true;
        this.finishedAt = this.at;
        if (event.outcome?.type === "interrupt" || this.legacyInterrupted)
          this.interrupted = {
            runId: effective(input),
            interruptIds:
              event.outcome?.type === "interrupt"
                ? event.outcome.interrupts.map((interrupt) => interrupt.id)
                : null,
          };
        else this.interrupted = undefined;
        this.activeRun = undefined;
        this.emit("agent.run", {
          phase: "finished",
          runId: event.runId,
          threadId: event.threadId,
          agentId: this.id,
        });
        extra(builder.rest(event));
      },
      onRunErrorEvent: ({ event }) => {
        this.runFinished = true;
        this.activeRun = undefined;
        this.emit("agent.run", {
          phase: "error",
          runId: this.page.lastRunId ?? null,
          threadId: this.threadId,
          agentId: this.id,
        });
        extra(builder.rest(event));
      },
      onCustomEvent: ({ event }) => {
        if (event.name === "on_interrupt") this.legacyInterrupted = true;
        extra(builder.rest(event));
      },
      onMessagesSnapshotEvent: ({ event, input }) => {
        for (const message of event.messages)
          if (!this.messageRuns.has(message.id))
            this.messageRuns.set(message.id, effective(input));
        extra(builder.rest(event));
      },
      onToolCallStartEvent: ({ event }) => {
        this.toolOrigins.set(event.toolCallId, {
          messageId: event.parentMessageId,
          runId: this.page.lastRunId,
        });
        this.emit("tool.call", {
          phase: "started",
          toolCallId: event.toolCallId,
          toolName: event.toolCallName,
          agentId: this.id,
          threadId: this.threadId,
          messageId: event.parentMessageId,
          runId: this.page.lastRunId,
        });
        builder.toolCallStarted(event);
        extra(builder.rest(event));
      },
      onToolCallEndEvent: ({ event, messages }) => {
        for (const payload of builder.toolCallEnded(event, messages))
          extra(payload);
      },
      onToolCallResultEvent: ({ event }) => {
        // LearningBridge forgets a call's origin once it has a result, unless the page is running it.
        if (!this.executingTools.has(event.toolCallId))
          this.toolOrigins.delete(event.toolCallId);
        builder.toolCallResult(event);
      },
      onTextMessageStartEvent: ({ event }) => extra(builder.rest(event)),
      onTextMessageEndEvent: ({ event }) => extra(builder.rest(event)),
      onReasoningStartEvent: ({ event }) => extra(builder.rest(event)),
      onReasoningMessageStartEvent: ({ event }) => extra(builder.rest(event)),
      onReasoningMessageEndEvent: ({ event }) => extra(builder.rest(event)),
      onReasoningEndEvent: ({ event }) => extra(builder.rest(event)),
      onReasoningEncryptedValueEvent: ({ event }) => extra(builder.rest(event)),
      onStateSnapshotEvent: ({ event }) => extra(builder.rest(event)),
      onStateDeltaEvent: ({ event }) =>
        extra(builder.stateDelta(event, this.at)),
      onActivitySnapshotEvent: ({ event }) => extra(builder.rest(event)),
      onActivityDeltaEvent: ({ event }) =>
        extra(builder.activityDelta(event, this.at)),
      onStepStartedEvent: ({ event }) => extra(builder.rest(event)),
      onStepFinishedEvent: ({ event }) => extra(builder.rest(event)),
      onRawEvent: ({ event }) => extra(builder.rest(event)),
      onSubagentStartedEvent: ({ event }) => extra(builder.rest(event)),
      onSubagentFinishedEvent: ({ event }) => extra(builder.rest(event)),
      onSubagentErrorEvent: ({ event }) => extra(builder.rest(event)),
      onRunFinalized: () => {
        for (const pending of builder.flushAll()) this.emitPending(pending);
      },
      onNewMessage: ({ message, input }) => {
        if (input) this.messageRuns.set(message.id, effective(input));
        else if (this.activeRun)
          this.messageRuns.set(message.id, this.activeRun);
        const text = textOf(message);
        this.emit("agent.message", {
          messageId: message.id,
          runId: this.runIdForMessage(message.id),
          threadId: this.threadId,
          agentId: this.id,
          role: message.role,
          textLength: text.length,
          ...(typeof message.content === "string" ? { text } : {}),
        });
        builder.messageExpressed(message);
        extra(builder.afterMessage(message));
      },
    };
  }

  /** A merged delta, held until something other than its next part arrives, with the time of its last part. */
  private emitPending({ payload, at }: { payload: Json; at: number }): void {
    this.output.emit(
      "agent.event",
      {
        threadId: this.threadId,
        runId: this.lastRunId,
        agentId: this.id,
        event: payload,
      },
      at,
    );
  }
}
