import type { BaseEvent } from "@ag-ui/client";
import { AbstractAgent } from "@ag-ui/client";
import {
  defer,
  EMPTY,
  finalize,
  from,
  Observable,
  Subject,
  switchMap,
  takeUntil,
  throwError,
} from "rxjs";
import type { ActorAgentResolver } from "../agents/agent-resolver";
import type {
  ExternalThreadBinding,
  ExternalThreadStore,
} from "../external/thread-store";
import type {
  CoworkerRouteResult,
  CoworkerRoutingService,
} from "../routing/service";
import {
  maybeCurrentSlackExecution,
  runWithSlackExecution,
  type SlackExecution,
} from "./execution-context";

type RunAgentInput = Parameters<AbstractAgent["run"]>[0];

export type OpenBotChannelAgentDependencies = {
  routing: CoworkerRoutingService;
  store: ExternalThreadStore;
  resolver: ActorAgentResolver;
};

type ActiveRun = {
  inner?: AbstractAgent;
  started: boolean;
  cancelled: boolean;
  cancellation: Subject<void>;
};

/**
 * A Channels-facing agent that pins a Slack thread to its first selected coworker.
 *
 * Slack identity stays in server-private execution state: the delegated AG-UI input is exactly the
 * one that Channels gave us, so none of the provider identity is exposed to a coworker or remote
 * endpoint.
 */
export class OpenBotChannelAgent extends AbstractAgent {
  private channelsConversationKey: string;
  private routing: CoworkerRoutingService;
  private store: ExternalThreadStore;
  private resolver: ActorAgentResolver;
  private execution?: SlackExecution;
  private executionForRun?: () => SlackExecution | undefined;
  private active?: ActiveRun;

  constructor(
    channelsConversationKey: string,
    deps: OpenBotChannelAgentDependencies,
    execution?: SlackExecution,
    executionForRun?: () => SlackExecution | undefined,
  ) {
    super({ agentId: "openbot-slack", description: "OpenBot Slack router" });
    this.channelsConversationKey = channelsConversationKey;
    this.routing = deps.routing;
    this.store = deps.store;
    this.resolver = deps.resolver;
    this.execution = execution;
    this.executionForRun = executionForRun;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    // Channels caches this agent by conversation. Resolve execution for every run so a detached
    // managed-delivery boundary can bridge the active turn without retaining the first turn's
    // mutable context on the cached agent.
    const execution =
      maybeCurrentSlackExecution() ??
      this.executionForRun?.() ??
      this.execution;
    if (!execution) {
      throw new Error(
        "A Slack agent run requires a private execution context.",
      );
    }
    const work = defer(() => {
      if (this.active) {
        return throwError(
          () => new Error("OpenBot Slack agent is already running."),
        );
      }
      const channelsThreadId = input.threadId;
      execution.channelsThreadId = channelsThreadId;
      const active: ActiveRun = {
        started: false,
        cancelled: false,
        cancellation: new Subject<void>(),
      };
      this.active = active;

      const work = from(this.resolve(execution, channelsThreadId)).pipe(
        switchMap((target) => {
          if (active.cancelled || this.active !== active) return EMPTY;
          active.inner = target;
          active.started = true;
          return this.runAndRemember(
            target,
            input,
            execution,
            channelsThreadId,
          );
        }),
        takeUntil(active.cancellation),
        finalize(() => {
          active.inner = undefined;
          if (this.active === active) this.active = undefined;
          active.cancellation.complete();
        }),
      );

      return new Observable<BaseEvent>((subscriber) => {
        let settled = false;
        const subscription = work.subscribe({
          next: (event) => subscriber.next(event),
          error: (error) => {
            settled = true;
            subscriber.error(error);
          },
          complete: () => {
            settled = true;
            subscriber.complete();
          },
        });
        return () => {
          if (!settled) this.cancel(active);
          subscription.unsubscribe();
        };
      });
    });
    return new Observable<BaseEvent>((subscriber) =>
      runWithSlackExecution(execution, () => {
        const subscription = work.subscribe(subscriber);
        return () => subscription.unsubscribe();
      }),
    );
  }

  private runAndRemember(
    target: AbstractAgent,
    input: RunAgentInput,
    execution: SlackExecution,
    channelsThreadId: string,
  ): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let assistantId: string | undefined;
      let assistantContent = "";
      const subscription = target.run(input).subscribe({
        next: (event) => {
          const candidate = event as BaseEvent & {
            messageId?: unknown;
            role?: unknown;
            delta?: unknown;
          };
          if (
            candidate.type === "TEXT_MESSAGE_START" &&
            candidate.role === "assistant" &&
            typeof candidate.messageId === "string"
          ) {
            assistantId = candidate.messageId;
          } else if (
            (candidate.type === "TEXT_MESSAGE_CONTENT" ||
              candidate.type === "TEXT_MESSAGE_CHUNK") &&
            typeof candidate.delta === "string" &&
            (assistantId === undefined ||
              candidate.messageId === undefined ||
              candidate.messageId === assistantId)
          ) {
            assistantContent += candidate.delta;
          }
          subscriber.next(event);
        },
        error: (error) => subscriber.error(error),
        complete: () => {
          if (assistantContent.length === 0) {
            subscriber.complete();
            return;
          }
          const userMessage = [...input.messages]
            .reverse()
            .find((message) => message.role === "user");
          void this.store
            .appendTranscriptTurn({
              channelsThreadId,
              user: {
                id: userMessage?.id ?? crypto.randomUUID(),
                role: "user",
                content: execution.messageText,
              },
              assistant: {
                id: assistantId ?? crypto.randomUUID(),
                role: "assistant",
                content: assistantContent,
              },
            })
            .then(
              () => subscriber.complete(),
              (error) => subscriber.error(error),
            );
        },
      });
      return () => subscription.unsubscribe();
    });
  }

  clone(): OpenBotChannelAgent {
    const cloned = super.clone() as OpenBotChannelAgent;
    cloned.channelsConversationKey = this.channelsConversationKey;
    cloned.routing = this.routing;
    cloned.store = this.store;
    cloned.resolver = this.resolver;
    cloned.execution = this.execution;
    cloned.executionForRun = this.executionForRun;
    cloned.active = undefined;
    return cloned;
  }

  abortRun(): void {
    const active = this.active;
    if (active) this.cancel(active);
    super.abortRun();
  }

  private cancel(active: ActiveRun): void {
    if (active.cancelled) return;
    active.cancelled = true;
    if (active.started) active.inner?.abortRun();
    active.cancellation.next();
    active.cancellation.complete();
  }

  private async resolve(
    execution: SlackExecution,
    channelsThreadId: string,
  ): Promise<AbstractAgent> {
    let binding = await this.store.getByChannelsThreadId(channelsThreadId);
    if (!binding) {
      const route = await this.routing.route({
        actor: execution.actor,
        text: execution.messageText,
      });
      binding = await this.bindSelectedRoute(
        execution,
        channelsThreadId,
        route,
      );
    }

    execution.agentId = binding.agentId;
    return this.resolver.resolveAgentForActor(execution.actor, binding.agentId);
  }

  private async bindSelectedRoute(
    execution: SlackExecution,
    channelsThreadId: string,
    route: CoworkerRouteResult,
  ): Promise<ExternalThreadBinding> {
    if (route.kind === "none") {
      throw new Error("No coworker is available to you.");
    }
    if (route.kind === "ambiguous") {
      throw new Error(`Name one coworker: ${route.names.join(", ")}.`);
    }

    return this.store.bind({
      channelsThreadId,
      provider: execution.provider,
      providerTenantId: execution.providerTenantId,
      providerConversationId: execution.providerConversationId,
      providerThreadId: execution.providerThreadId,
      agentId: route.agentId,
      agentName: route.name,
      createdByUserId: execution.actor.id,
    });
  }
}
