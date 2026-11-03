import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import {
  BuiltInAgent,
  type BuiltInAgentConfiguration,
  CopilotKitIntelligence,
} from "@copilotkit/runtime/v2";
import {
  defer,
  finalize,
  from,
  fromEvent,
  type Observable,
  of,
  switchMap,
  takeUntil,
} from "rxjs";
import { sanitizeSeededHistory } from "../history-sanitize";
import {
  type NativeRunScope,
  nativeApprovalRun,
  nativeRunScope,
  withinNativeRun,
} from "../native-approval";
import { historyOrEmpty } from "../thread-history";

/**
 * The CopilotKit agents OpenBot runs its Bots as: a built-in Bot that will not send a broken
 * conversation, one whose tools are chosen when its run starts, a remote Bot that survives being
 * cloned, a Bot that is no longer there, and the platform client with one answer corrected.
 *
 * Moved out of the server's copilot.ts. What the server does around a run — inlining attachments,
 * watching the model connection — comes in as {@link BuiltInAgentHooks}, so nothing here imports it.
 */

/**
 * The reason a finished run's build is aborted with, so a pending model call can tell a run that
 * ended normally from one somebody stopped. Read by the server's plan model.
 */
export const PLAN_RUN_COMPLETED = Symbol("plan-run-completed");

/** The RUN_ERROR code of a built-in run refused before its model call by `admitTools`. */
export const TOOL_LIMIT_EXCEEDED = "OPENBOT_TOOL_LIMIT_EXCEEDED";

type AgentHeaders = Record<string, string>;
type HeaderBearingAgent = AbstractAgent & { headers?: AgentHeaders };

/** What the host does around a built-in Bot's run. */
export type BuiltInAgentHooks = {
  /**
   * Replace a person's attached files with their bytes, given the run's conversation. Absent, the
   * conversation goes up as it is, without deferring the run.
   */
  inline?: (messages: Message[], threadId: string) => Promise<Message[]>;
  /** Watch the model connection, for a host that reports when it fails. */
  observe: (run: Observable<BaseEvent>) => Observable<BaseEvent>;
  /**
   * Decide, before the model is called, whether a run that would send these tools may go ahead.
   * A sentence refuses it: the run ends with that sentence as its RUN_ERROR and no provider is
   * called. Absent, every run goes ahead. See {@link toolNamesSent} for what the names are.
   */
  admitTools?: (toolNames: readonly string[]) => string | undefined;
  /** The configured tools that wait behind tool search, which {@link toolNamesSent} leaves out. */
  waiting?: ReadonlySet<string>;
};

/**
 * The tools `BuiltInAgent.run` adds to every run, whatever it was configured with.
 *
 * Copied from `@copilotkit/runtime`'s agent (`dist/agent/index.mjs`, where `run` spreads them into
 * `streamTextParams.tools`), because a count that leaves them out is two short of what the provider
 * is sent, and a limit is exactly where two matters.
 */
export const RUNTIME_STATE_TOOLS = [
  "AGUISendStateSnapshot",
  "AGUISendStateDelta",
] as const;

/**
 * The names of the tools a built-in run will send its model provider on its first step, before
 * anything is sent.
 *
 * The same union `BuiltInAgent.run` makes: the client's tools from the request, the configured
 * tools over them (by name, so a client tool the Bot also holds is one tool, not two), and the
 * runtime's own state tools. Less whatever waits behind tool search, which is registered with the
 * runtime and not sent until a search finds it, and then only into the room left under the limit.
 * Counting it would refuse exactly the runs search exists to let through. A factory configuration
 * declares no tools here.
 */
export function toolNamesSent(
  configuration: BuiltInAgentConfiguration,
  input: Pick<RunAgentInput, "tools">,
  waiting: ReadonlySet<string> = new Set(),
): string[] {
  const configured =
    "tools" in configuration ? (configuration.tools ?? []) : [];
  return [
    ...new Set([
      ...(input.tools ?? []).map((tool) => tool.name),
      ...configured.map((tool) => tool.name),
      ...RUNTIME_STATE_TOOLS,
    ]),
  ].filter((name) => !waiting.has(name));
}

export class CloningRemoteAgent extends AbstractAgent {
  headers?: AgentHeaders;
  private readonly remote: HeaderBearingAgent;

  constructor(
    remote: AbstractAgent,
    private readonly attachOpenBotMiddleware: (target: AbstractAgent) => void,
  ) {
    super({
      agentId: remote.agentId,
      description: remote.description,
      threadId: remote.threadId,
      initialMessages: remote.messages,
      initialState: remote.state,
      debug: remote.debug,
    });
    this.remote = remote as HeaderBearingAgent;
    if (this.remote.headers) {
      this.headers = { ...this.remote.headers };
    }
    this.attachOpenBotMiddleware(this);
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    if (this.headers) {
      this.remote.headers = { ...this.headers };
    }
    return this.remote.run(input);
  }

  async getCapabilities() {
    return this.remote.getCapabilities?.() ?? {};
  }

  abortRun(): void {
    this.remote.abortRun();
    super.abortRun();
  }

  clone() {
    const clonedRemote = this.remote.clone() as AbstractAgent;
    const clone = new CloningRemoteAgent(
      clonedRemote,
      this.attachOpenBotMiddleware,
    );
    if (this.headers) {
      clone.headers = { ...this.headers };
    }
    return clone;
  }
}

/**
 * A built-in Bot that will not hand the model provider a conversation it is going to refuse.
 *
 * FOUND LIVE, ON CHAT. One person's next three messages each failed with
 * `AI_MissingToolResultsError: Tool result is missing for tool call chatcmpl-tool-8dd56dc7497c5ea9`,
 * thrown out of the AI SDK's `convertToLanguageModelPrompt`. A frontend tool handler had been torn
 * down while its call was open, so the agent's live messages in the browser carried an assistant
 * message whose tool call never got a result. The durable store did not have it, nothing was going
 * to answer it, and every retry sent it straight back up as `input.messages`. The conversation was
 * finished until the person worked out for themselves to start another one.
 *
 * The guard has to be on this side of `run`. `BuiltInAgent.run` converts `input.messages` itself,
 * with no seam in between, so wrapping the agent is the only place left to stand. The reasoning for
 * why a dangling call is DROPPED rather than repaired, and why ids are never changed, is in
 * `toolkit/history-sanitize.ts`, where the routines path found the same failure first.
 *
 * A RESUMED CALL IS NOT A DANGLE. `run` appends a tool result for each `input.resume` entry by
 * `interruptId` AFTER converting the messages, so a call that a resume is about to answer must
 * survive this pass or the appended result lands on nothing.
 */
export class BuiltInAgentWithSaneHistory extends BuiltInAgent {
  /**
   * The configuration, held a second time because the base class keeps its own copy private and
   * {@link clone} has to build another one of THIS class rather than of the base.
   */
  private readonly configuration: BuiltInAgentConfiguration;
  /**
   * What the host does around a run: how it inlines a person's attached files, and how it watches
   * the model connection. Held for the same reason {@link configuration} is: {@link clone} builds
   * another one of THIS class, and a seam lost in a clone is a seam that never runs.
   */
  private readonly hooks: BuiltInAgentHooks;
  /**
   * The run this agent is in, which its tools re-enter when the AI SDK calls them. One per agent,
   * and so one per clone: the runtime clones before every run. See `NativeRunScope`.
   */
  private readonly scope: NativeRunScope;

  constructor(
    configuration: BuiltInAgentConfiguration,
    hooks: BuiltInAgentHooks,
  ) {
    const scope = nativeRunScope();
    super(toolsWithin(configuration, scope));
    this.configuration = configuration;
    this.hooks = hooks;
    this.scope = scope;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    /*
     * FIRST, before the history is touched or an attachment is stamped as sent. A run refused here
     * never started, and nothing downstream should record it as though it had.
     */
    const refusal = this.hooks.admitTools?.(
      toolNamesSent(this.configuration, input, this.hooks.waiting),
    );
    if (refusal !== undefined)
      return of(
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent,
        {
          type: EventType.RUN_ERROR,
          message: refusal,
          code: TOOL_LIMIT_EXCEEDED,
        } as BaseEvent,
      );
    const answeredByResume = new Set(
      (input.resume ?? []).map((entry) => entry.interruptId),
    );
    const history = sanitizeSeededHistory(input.messages, answeredByResume);
    const { inline, observe } = this.hooks;
    /*
     * ALONGSIDE THE GUARD ABOVE, NOT INSTEAD OF IT. One drops a conversation the model provider is
     * going to refuse; this replaces the stored reference a person's attachment arrives as with the
     * bytes themselves, because `BuiltInAgent.run` converts `input.messages` with no seam in
     * between and a `/api/attachments/<id>` URL is not something a model provider will go and fetch.
     *
     * Nothing to load means nothing to inline, and the run goes up exactly as it did before any of
     * this existed.
     */
    if (!inline)
      return nativeApprovalRun(
        { ...input, messages: history },
        () => observe(super.run({ ...input, messages: history })),
        this.scope,
      );
    /*
     * Deferred, because `run` has to answer with a stream straight away and reading the bytes is a
     * database round trip. `defer` puts that read on the subscription, which is where the run
     * actually begins, so nothing is fetched until somebody is listening.
     */
    return defer(() =>
      from(
        // The run's own conversation, not the actor's channels at large.
        inline(history, input.threadId),
      ).pipe(
        switchMap((messages) =>
          nativeApprovalRun(
            { ...input, messages },
            () => observe(super.run({ ...input, messages })),
            this.scope,
          ),
        ),
      ),
    );
  }

  override abortRun(): void {
    super.abortRun();
    // A suspension already stopped the provider. Stop must also close its tool-settlement wait,
    // even when a tool is still finishing work that does not observe the provider's abort signal.
    this.scope.run?.abort();
  }

  /**
   * Carried by hand, for the same reason {@link RunBuiltAgent.clone} is.
   *
   * The runtime clones an agent before every run, and the base class's clone hard-codes
   * `new BuiltInAgent(this.config)`: inherited unchanged, the very first message anybody sends
   * would go through an agent that does none of the above. The middleware list is copied because
   * the base clone copies it, and it is reached through a cast because `AbstractAgent` declares it
   * private. Nothing registers middleware on a built-in Bot today, and this is here so that the day
   * something does, it is not lost in a clone.
   */
  clone(): BuiltInAgentWithSaneHistory {
    const cloned = new BuiltInAgentWithSaneHistory(
      this.configuration,
      this.hooks,
    );
    type WithMiddlewares = { middlewares: unknown[] };
    (cloned as unknown as WithMiddlewares).middlewares = [
      ...(this as unknown as WithMiddlewares).middlewares,
    ];
    return cloned;
  }
}

/**
 * The configuration with each tool's execute re-entering the agent's run, so a tool the AI SDK calls
 * from a stream that lost its async context still asks in the conversation that called it. A factory
 * configuration builds its own tools and has none here.
 */
function toolsWithin(
  configuration: BuiltInAgentConfiguration,
  scope: NativeRunScope,
): BuiltInAgentConfiguration {
  if ("factory" in configuration || !configuration.tools) return configuration;
  return {
    ...configuration,
    tools: configuration.tools.map((tool) =>
      tool.execute
        ? { ...tool, execute: withinNativeRun(scope, tool.execute) }
        : tool,
    ),
  };
}

/**
 * An agent whose tools are decided when the run starts, because that is the first moment anybody
 * knows what the run is about, and who is asking on whose behalf.
 *
 * WHY A WRAPPER AND NOT A NARROWER `loadTools`. Tools are resolved per request, and a request is
 * earlier than a run: at that point there is a Bot and a person and no message, so there is nothing
 * to select against. `run(input)` is the first place the message exists. Both underlying agents take
 * their tools at construction — a built-in one in its configuration, a remote one in the middleware
 * that sends them — so the only way to hand either a set chosen from the message is to build it
 * after the message arrives. That is all this does: it defers `build` to the first subscription and
 * then gets out of the way.
 *
 * The deferral is per subscription, so a retried run reselects rather than reusing a decision made
 * for a message that is no longer the last one.
 */
export class RunBuiltAgent extends AbstractAgent {
  /**
   * Stop must reach the pending build as well as the eventual model. Keep both in one per-run
   * record so a late build or teardown cannot replace the next run's cancellation target.
   */
  private active?: { controller: AbortController; inner?: AbstractAgent };
  /** The same Bot with nothing narrowed, kept to answer questions that are not about one run. */
  private whole: AbstractAgent;
  private build: (
    input: RunAgentInput,
    signal: AbortSignal,
  ) => Promise<AbstractAgent>;

  constructor(
    identity: { agentId: string; description: string },
    whole: AbstractAgent,
    build: (
      input: RunAgentInput,
      signal: AbortSignal,
    ) => Promise<AbstractAgent>,
  ) {
    super(identity);
    this.whole = whole;
    this.build = build;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return defer(() => {
      const active: NonNullable<RunBuiltAgent["active"]> = {
        controller: new AbortController(),
      };
      this.active = active;
      const { signal } = active.controller;
      return defer(() => this.build(input, signal)).pipe(
        switchMap((agent) => {
          signal.throwIfAborted();
          active.inner = agent;
          return agent.run(input);
        }),
        // Settle Stop even if a collaborator ignores the signal or rejects after cancellation.
        takeUntil(fromEvent(signal, "abort")),
        finalize(() => {
          if (this.active === active) this.active = undefined;
          active.controller.abort(PLAN_RUN_COMPLETED);
        }),
      );
    });
  }

  /**
   * What the Bot can do, answered from the un-narrowed agent.
   *
   * Capabilities are asked for outside a run, where there is no message and so nothing to select
   * against. They are also a fact about the Bot rather than about one turn: a deployment that
   * narrowed this run to three tools has not stopped supporting whatever the underlying agent
   * supports.
   */
  getCapabilities() {
    return this.whole.getCapabilities?.() ?? Promise.resolve({});
  }

  /**
   * Carried by hand, because `AbstractAgent.clone` does not know this class exists.
   *
   * It builds a bare object on the prototype and copies a fixed list of base fields onto it, so
   * every field declared here arrives `undefined`. The runtime clones an agent before every run
   * (`agents[agentId].clone()`), which means the omission is not a corner case: without this, the
   * first message anybody sends fails on a `build` that is not a function.
   */
  clone(): RunBuiltAgent {
    const cloned = super.clone() as RunBuiltAgent;
    cloned.whole = this.whole;
    cloned.build = this.build;
    // A clone owns its cancellation state, including while its build is pending.
    cloned.active = undefined;
    return cloned;
  }

  abortRun(): void {
    const active = this.active;
    active?.controller.abort();
    active?.inner?.abortRun();
    super.abortRun();
  }
}

export class UnavailableAgent extends AbstractAgent {
  private reason: string;

  constructor(agent: { id: string; name: string; reason: string }) {
    super({ agentId: agent.id, description: agent.name });
    this.reason = agent.reason;
  }

  clone(): UnavailableAgent {
    const cloned = super.clone() as UnavailableAgent;
    // The runtime clones before running; the base clone only carries base-class fields.
    cloned.reason = this.reason;
    return cloned;
  }

  // Refused here rather than at the endpoint: a deleted coworker has no endpoint worth contacting,
  // and the person is owed the reason rather than a transport error.
  run(): never {
    throw new Error(this.reason);
  }
}

/**
 * The platform client, with one answer corrected.
 *
 * A subclass rather than a wrapper. The runtime is handed this object and calls many methods on it,
 * and the base class keeps its state in `#private` fields. Extending keeps every other method on
 * the instance that owns those fields. The authentication observer separately binds methods to
 * that original instance, so it preserves this override and its private-field receiver.
 *
 * `getThreadMessages` is one override. `handleGetThreadMessages` in the runtime calls it and
 * returns `Response.json` of whatever comes back, so an empty history here is the `{ messages: [] }`
 * the browser expects and a 200 instead of a 500.
 *
 * `ɵgetClientWsUrl` is the other, and only when `browserWsUrl` is given. That address is the one
 * the runtime sends the browser in `/info`, and the browser opens it itself, so it has to be the
 * gateway as the browser can reach it. A server in a container reaches local Intelligence at
 * `host.docker.internal`, which a browser on the host cannot resolve, while the browser's
 * `localhost` is, inside the container, the container. Everything the server opens itself, the
 * runner and channel sockets, stays on `wsUrl`.
 */
export class IntelligenceKnowingANewThread extends CopilotKitIntelligence {
  readonly #browserClientWsUrl: string | undefined;

  constructor(
    config: ConstructorParameters<typeof CopilotKitIntelligence>[0] & {
      browserWsUrl?: string;
    },
  ) {
    const { browserWsUrl, ...platform } = config;
    super(platform);
    const browser = browserWsUrl?.trim();
    this.#browserClientWsUrl = browser ? clientSocket(browser) : undefined;
  }

  override ɵgetClientWsUrl(): string {
    return this.#browserClientWsUrl ?? super.ɵgetClientWsUrl();
  }

  override getThreadMessages(
    params: Parameters<CopilotKitIntelligence["getThreadMessages"]>[0],
  ) {
    return historyOrEmpty(() => super.getThreadMessages(params), {
      messages: [],
    });
  }
}

/**
 * The gateway's client socket, from any of the three addresses the platform names it by.
 *
 * The rule the runtime applies to `wsUrl` (`deriveClientWsUrl`, which it does not export), so a
 * browser address written the way the server's is lands on the same path.
 */
function clientSocket(wsUrl: string): string {
  const base = wsUrl.replace(/\/$/, "");
  for (const socket of ["/client", "/runner", "/channels"]) {
    if (base.endsWith(socket)) return `${base.slice(0, -socket.length)}/client`;
  }
  return `${base}/client`;
}
