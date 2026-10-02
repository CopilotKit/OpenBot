import { AsyncLocalStorage } from "node:async_hooks";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  Middleware,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable, type Subscription } from "rxjs";
import type { AuditInitiator } from "../audit";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import { withApprovalContext } from "./types";

type NativeRun = {
  input: RunAgentInput;
  messages: Message[];
  state: unknown;
  waiting?: HeadlessToolSuspension;
  waitForCall(id: string): Promise<void>;
  suspend(error: HeadlessToolSuspension): void;
};
const nativeRuns = new AsyncLocalStorage<NativeRun>();

/** Where a suspended run's waiting details ride on its AG-UI interrupt. */
export const OPENBOT_WAITING_METADATA = "openbotWaiting";

export async function executeNativeApprovalTool<T>(
  name: string,
  args: unknown,
  toolCallId: string | undefined,
  initiator: AuditInitiator | undefined,
  execute: () => Promise<T>,
): Promise<T> {
  const run = nativeRuns.getStore();
  if (!run || !toolCallId) return execute();
  if (run.waiting) throw run.waiting;
  await run.waitForCall(toolCallId);
  if (run.waiting) throw run.waiting;
  const callMessage = run.messages.find(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls?.some((call) => call.id === toolCallId),
  );
  if (!callMessage)
    throw new Error(
      "The native tool call was not captured in its AG-UI conversation.",
    );
  const continuation = {
    runId: run.input.runId,
    threadId: run.input.threadId,
    toolCallId,
    toolName: name,
    args,
    messages: run.messages,
    state: run.state,
    context: run.input.context,
    forwardedProps: run.input.forwardedProps,
    initiator,
  };
  try {
    return await withApprovalContext(continuation, execute);
  } catch (error) {
    if (error instanceof HeadlessToolSuspension) {
      run.waiting = error;
      run.suspend(error);
    }
    throw error;
  }
}

class NativeStream extends AbstractAgent {
  constructor(
    private readonly source: () => Observable<BaseEvent>,
    input: RunAgentInput,
  ) {
    super({ initialMessages: input.messages, initialState: input.state });
  }
  run() {
    return this.source();
  }
}
class NativeApprovalMiddleware extends Middleware {
  run(input: RunAgentInput, next: AbstractAgent) {
    return new Observable<BaseEvent>((subscriber) => {
      let subscription: Subscription | undefined;
      const captured = new Set<string>();
      const awaiting = new Map<
        string,
        {
          resolve(): void;
          reject(error: Error): void;
          timer: ReturnType<typeof setTimeout>;
        }
      >();
      const run: NativeRun = {
        input,
        messages: input.messages,
        state: input.state,
        waitForCall(id) {
          if (captured.has(id)) return Promise.resolve();
          return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              awaiting.delete(id);
              reject(
                new Error(
                  "The native tool call was not emitted through AG-UI.",
                ),
              );
            }, 2_000);
            awaiting.set(id, { resolve, reject, timer });
          });
        },
        suspend(error) {
          subscriber.next({
            type: EventType.CUSTOM,
            name: "openbot.headless.waiting",
            value: { ...error.waiting, message: error.message },
          });
          subscriber.next({
            type: EventType.RUN_FINISHED,
            runId: input.runId,
            threadId: input.threadId,
            outcome: {
              type: "interrupt",
              interrupts: [
                {
                  id: String(
                    error.waiting.continuation &&
                      typeof error.waiting.continuation === "object" &&
                      "toolCallId" in error.waiting.continuation
                      ? error.waiting.continuation.toolCallId
                      : (error.waiting.requestId ?? "approval"),
                  ),
                  reason: "human_input",
                  message: error.message,
                  // Also on the interrupt: a run relayed through Intelligence arrives without the
                  // CUSTOM event above, and the interrupt is what a headless turn still sees.
                  metadata: {
                    [OPENBOT_WAITING_METADATA]: {
                      ...error.waiting,
                      message: error.message,
                    },
                  },
                },
              ],
            },
          });
          subscriber.complete();
          subscription?.unsubscribe();
        },
      };
      subscription = nativeRuns.run(run, () =>
        this.runNextWithState(input, next).subscribe({
          next({ event, messages, state }) {
            run.messages = messages;
            run.state = state;
            if (!run.waiting) subscriber.next(event);
            if (
              event.type === EventType.TOOL_CALL_END &&
              typeof event.toolCallId === "string"
            ) {
              captured.add(event.toolCallId);
              const pending = awaiting.get(event.toolCallId);
              if (pending) {
                clearTimeout(pending.timer);
                awaiting.delete(event.toolCallId);
                pending.resolve();
              }
            }
          },
          error: (error) => subscriber.error(error),
          complete: () => subscriber.complete(),
        }),
      );
      return () => {
        subscription?.unsubscribe();
        for (const pending of awaiting.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("The native tool run was stopped."));
        }
        awaiting.clear();
      };
    });
  }
}
export function nativeApprovalRun(
  input: RunAgentInput,
  source: () => Observable<BaseEvent>,
) {
  return new NativeApprovalMiddleware().run(
    input,
    new NativeStream(source, input),
  );
}
