import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  Middleware,
  type RunAgentInput,
  type RunFinishedEvent,
  type Tool,
  type ToolCall,
} from "@ag-ui/client";
import { NOT_RUN_AFTER_FAILURE } from "@openbot/shared/approval-outcomes";
import { isDecisionTool } from "@openbot/shared/decision-tools";
import {
  calledTooEarly,
  drawnTooEarlyAnswer,
  isComputerCall,
} from "@openbot/shared/tool-steps";
import { OPENBOT_WAITING_METADATA } from "@openbot/shared/waiting";
import { Observable, type Subscription } from "rxjs";
import { withApprovalContext } from "./continuation";
import type { AuditInitiator } from "./initiator";

/**
 * What a person reads when a Bot's stream ends with neither an answer nor an error.
 *
 * It used to read "Remote agent ended without a terminal event.", in red under the message: seen on
 * OpenBot Desktop when the LangGraph harness died on a provider's refusal it did not catch. The
 * harness now ends every run with an error of its own, so this is for a Bot that still does not.
 */
export const RUN_ENDED_EARLY =
  "The Bot stopped before it finished answering. Try again.";

/** Client tools supplied by OpenBot when the caller has no browser. */
export type HeadlessTool = {
  definition: Tool;
  /**
   * Executed when called but never offered to the model. For a tool the Bot does not hold, so a
   * call it makes anyway gets a governed refusal rather than going unanswered.
   */
  hidden?: boolean;
  /**
   * Started with the other calls of its step rather than after them. Calls are otherwise run one at
   * a time, in order, because a browser's clicks and typing depend on the page the last one left.
   */
  concurrent?: boolean;
  /**
   * Draws a component in the conversation, as the gallery's do. One asked for in the same step as
   * any other kind of call is answered as drawn too early and not recorded; see
   * `shared/tool-steps.ts`.
   */
  component?: boolean;
  execute(
    args: unknown,
    context: { toolCallId: string; signal: AbortSignal },
  ): Promise<unknown>;
};

/** Where a suspended run's waiting details ride on its AG-UI interrupt. Shared with the browser. */
export { OPENBOT_WAITING_METADATA };

export type HeadlessWaiting = {
  kind: string;
  requestId?: string;
  [key: string]: unknown;
};

/** A durable request remains open; continuing the Bot would invent a human answer. */
export class HeadlessToolSuspension extends Error {
  constructor(
    message: string,
    readonly waiting: HeadlessWaiting,
  ) {
    super(message);
    this.name = "HeadlessToolSuspension";
  }
}

const MAX_TOOL_SEGMENTS = 30;

/**
 * Executes AG-UI client tools inside the Intelligence run. Backend results are
 * forwarded unchanged; only newly emitted unanswered calls can be executed.
 */
export class HeadlessToolsMiddleware extends Middleware {
  constructor(
    private readonly tools: HeadlessTool[],
    private readonly initiator?: AuditInitiator,
  ) {
    super();
    const names = tools.map((tool) => tool.definition.name);
    if (new Set(names).size !== names.length)
      throw new Error("Headless tool names must be unique.");
  }

  run(
    originalInput: RunAgentInput,
    next: AbstractAgent,
  ): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const controller = new AbortController();
      const tools = new Map(
        this.tools.map((tool) => [tool.definition.name, tool]),
      );
      // A browser chat offers its own computer tools; a plugin added beside them must not answer those.
      const callerOffers = new Set(
        originalInput.tools
          .map((tool) => tool.name)
          .filter((name) => !tools.has(name)),
      );
      const executed = new Set<string>();
      let subscription: Subscription | undefined;
      let started = false;
      const work = async () => {
        let request: RunAgentInput = {
          ...originalInput,
          tools: [
            ...originalInput.tools.filter((tool) => !tools.has(tool.name)),
            ...this.tools
              .filter((tool) => !tool.hidden)
              .map((tool) => tool.definition),
          ],
        };
        for (let segment = 0; segment <= MAX_TOOL_SEGMENTS; segment += 1) {
          if (subscriber.closed) return;
          const historical = new Set(
            request.messages.flatMap((message) =>
              message.role === "assistant"
                ? (message.toolCalls ?? []).map((call) => call.id)
                : [],
            ),
          );
          const emitted = new Set<string>();
          let messages = request.messages;
          let state = request.state;
          let terminal: RunFinishedEvent | undefined;
          let failed = false;
          await new Promise<void>((resolve, reject) => {
            subscription = this.runNextWithState(
              request,
              new InvocationTransport(next, request),
            ).subscribe({
              next: ({
                event,
                messages: updatedMessages,
                state: updatedState,
              }) => {
                messages = updatedMessages;
                state = updatedState;
                if (event.type === EventType.TOOL_CALL_START)
                  emitted.add(String(event.toolCallId));
                if (event.type === EventType.MESSAGES_SNAPSHOT) {
                  for (const message of messages) {
                    if (message.role !== "assistant") continue;
                    for (const call of message.toolCalls ?? []) {
                      if (!historical.has(call.id)) emitted.add(call.id);
                    }
                  }
                }
                if (event.type === EventType.RUN_FINISHED) {
                  terminal = event as RunFinishedEvent;
                  return;
                }
                if (event.type === EventType.RUN_STARTED) {
                  if (started) return;
                  started = true;
                }
                if (event.type === EventType.RUN_ERROR) failed = true;
                subscriber.next(event);
              },
              error: reject,
              complete: resolve,
            });
          });
          if (subscriber.closed || failed) return;
          if (!terminal) throw new Error(RUN_ENDED_EARLY);
          const answered = new Set(
            messages.flatMap((message) =>
              message.role === "tool" ? [message.toolCallId] : [],
            ),
          );
          const pending: ToolCall[] = messages.flatMap((message) =>
            message.role === "assistant"
              ? (message.toolCalls ?? []).filter(
                  (call) =>
                    emitted.has(call.id) &&
                    !historical.has(call.id) &&
                    !answered.has(call.id) &&
                    !executed.has(call.id),
                )
              : [],
          );
          const owned = pending.filter(
            (call) =>
              tools.has(call.function.name) ||
              (call.function.name.startsWith("computer_") &&
                !callerOffers.has(call.function.name)),
          );
          if (owned.length === 0) {
            subscriber.next(terminal);
            return;
          }
          if (segment === MAX_TOOL_SEGMENTS)
            throw new Error(
              "The headless tool continuation limit was reached.",
            );
          const results = new Map<string, string>();
          const run = async (call: ToolCall, seen: Message[]) => {
            const tool = tools.get(call.function.name);
            if (!tool)
              throw new Error(
                `The tool ${call.function.name} is unavailable for this headless turn.`,
              );
            const args: unknown = JSON.parse(call.function.arguments || "{}");
            const continuation = {
              runId: request.runId,
              threadId: request.threadId,
              toolCallId: call.id,
              toolName: call.function.name,
              args,
              messages: seen,
              state,
              context: request.context,
              forwardedProps: request.forwardedProps,
              initiator: this.initiator,
            };
            return withApprovalContext(continuation, () =>
              tool.execute(args, {
                toolCallId: call.id,
                signal: controller.signal,
              }),
            );
          };
          /*
           * A tool that may run beside the others is started now, with them all, and its result is
           * taken in order below like any other. One that is never reached, because an earlier call
           * stopped the run, is stopped with it by the abort on teardown; its rejection is observed
           * here so it is not reported as unhandled.
           */
          const early = new Map<string, Promise<unknown>>();
          for (const call of owned) {
            if (!tools.get(call.function.name)?.concurrent) continue;
            const started = run(call, messages);
            started.catch(() => undefined);
            early.set(call.id, started);
          }
          /*
           * A step's rules (`shared/tool-steps.ts`): a component asked for beside another kind of
           * call is not recorded, and a computer action after one that failed in its step is not
           * run. Both are answered, so every call still has its answer.
           */
          const isComponent = (name: string) =>
            tools.get(name)?.component === true || isDecisionTool(name);
          const failedSteps = new Set<string>();
          for (const call of owned) {
            if (subscriber.closed) return;
            executed.add(call.id);
            let content: string;
            let error: string | undefined;
            const step = stepIdOf(messages, call.id);
            const computer = isComputerCall(call.function.name);
            const refusal = early.has(call.id)
              ? undefined
              : tools.get(call.function.name)?.component &&
                  calledTooEarly(messages, call.id, isComponent)
                ? drawnTooEarlyAnswer(call.function.name)
                : computer && step !== undefined && failedSteps.has(step)
                  ? NOT_RUN_AFTER_FAILURE
                  : undefined;
            try {
              if (refusal !== undefined) {
                content = refusal;
                error = refusal;
              } else {
                const result = await (early.get(call.id) ??
                  run(call, messages));
                content =
                  typeof result === "string" ? result : JSON.stringify(result);
                if (content === undefined)
                  throw new Error(
                    `The tool ${call.function.name} returned no result.`,
                  );
                if (computer && step !== undefined && failedOutcome(result))
                  failedSteps.add(step);
              }
            } catch (failure) {
              if (failure instanceof HeadlessToolSuspension) {
                failure.waiting.continuation ??= {
                  runId: request.runId,
                  threadId: request.threadId,
                  toolCallId: call.id,
                  toolName: call.function.name,
                  args: JSON.parse(call.function.arguments || "{}"),
                  messages,
                  state,
                  context: request.context,
                  forwardedProps: request.forwardedProps,
                  initiator: this.initiator,
                };
                subscriber.next({
                  type: EventType.CUSTOM,
                  name: "openbot.headless.waiting",
                  value: {
                    ...failure.waiting,
                    message: failure.message,
                    toolCallId: call.id,
                  },
                });
                subscriber.next({
                  ...terminal,
                  outcome: {
                    type: "interrupt",
                    interrupts: [
                      {
                        id: call.id,
                        toolCallId: call.id,
                        reason: "human_input",
                        message: failure.message,
                        metadata: { openbotWaiting: failure.waiting },
                      },
                    ],
                  },
                });
                return;
              }
              error =
                failure instanceof Error ? failure.message : String(failure);
              content = JSON.stringify({ ok: false, error });
              if (computer && step !== undefined) failedSteps.add(step);
            }
            if (subscriber.closed) return;
            const message: Message = {
              id: crypto.randomUUID(),
              role: "tool",
              toolCallId: call.id,
              content,
              ...(error ? { error } : {}),
            };
            messages = [...messages, message];
            results.set(call.id, content);
            // AG-UI 1.0's TOOL_CALL_RESULT has no `error` field and validation strips one; the
            // refusal travels in `content`, and on the tool message, which keeps `error`.
            subscriber.next({
              type: EventType.TOOL_CALL_RESULT,
              messageId: message.id,
              toolCallId: call.id,
              role: "tool",
              content,
            });
          }
          const interrupts =
            terminal.outcome?.type === "interrupt"
              ? terminal.outcome.interrupts
              : [];
          const unresolved = interrupts.filter(
            (interrupt) => !results.has(interrupt.toolCallId ?? interrupt.id),
          );
          if (owned.length !== pending.length || unresolved.length > 0) {
            subscriber.next(
              unresolved.length > 0
                ? {
                    ...terminal,
                    outcome: { type: "interrupt", interrupts: unresolved },
                  }
                : terminal,
            );
            return;
          }
          request = {
            ...request,
            messages,
            state,
            resume:
              interrupts.length > 0
                ? interrupts.map((interrupt) => ({
                    interruptId: interrupt.id,
                    status: "resolved" as const,
                    payload: results.get(interrupt.toolCallId ?? interrupt.id),
                  }))
                : undefined,
          };
        }
      };
      // Observable teardown owns cancellation; both asynchronous exits are observed.
      work().then(
        () => subscriber.complete(),
        (error: unknown) => {
          if (subscriber.closed) return;
          subscriber.next({
            type: EventType.RUN_ERROR,
            code: "OPENBOT_HEADLESS_TOOL_ERROR",
            message: error instanceof Error ? error.message : String(error),
          });
          subscriber.complete();
        },
      );
      return () => {
        controller.abort();
        subscription?.unsubscribe();
      };
    });
  }
}

/** The id of the assistant message, the step, that holds this call. */
function stepIdOf(
  messages: readonly Message[],
  toolCallId: string,
): string | undefined {
  return messages.find(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls?.some((call) => call.id === toolCallId),
  )?.id;
}

/** Whether a computer action answered that it did not work: refused, failed, or not carried out. */
function failedOutcome(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { ok?: unknown }).ok === false
  );
}

/** AG-UI accumulation reads transport history, so seed each continuation explicitly. */
class InvocationTransport extends AbstractAgent {
  constructor(
    private readonly transport: AbstractAgent,
    input: RunAgentInput,
  ) {
    super({ initialMessages: input.messages, initialState: input.state });
  }
  run(input: RunAgentInput) {
    return this.transport.run(input);
  }
}
