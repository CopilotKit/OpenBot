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
import { withApprovalContext } from "./continuation";
import {
  HeadlessToolSuspension,
  OPENBOT_WAITING_METADATA,
} from "./headless-tools";
import type { AuditInitiator } from "./initiator";

export { OPENBOT_WAITING_METADATA };

type NativeRun = {
  input: RunAgentInput;
  messages: Message[];
  state: unknown;
  waiting?: HeadlessToolSuspension;
  pending: Set<Promise<unknown>>;
  abort(): void;
  waitForCall(id: string): Promise<void>;
  suspend(error: HeadlessToolSuspension): Promise<void>;
};
const nativeRuns = new AsyncLocalStorage<NativeRun>();

/**
 * The run a built-in Bot's tools belong to, held by the agent that runs them.
 *
 * THE SCOPE DOES NOT SURVIVE THE MODEL'S STREAM ON BUN. The AI SDK runs a step's tools when the
 * provider's stream ends, from the provider's `flush`, and Bun calls a stream's `flush` with no
 * async context when the end of a fetched body arrives on its own, after the last event: the way a
 * real provider closes its connection a moment after it has finished. So every native tool call in a
 * real conversation ran with no run in scope, and so with no approval context: the gate had no
 * conversation to ask in, and a send to other people was refused outright as "not part of a run
 * that can ask". A fake model that closes its body with its last event keeps the scope, which is how
 * this went unseen.
 *
 * SO THE RUN IS CARRIED BY THE TOOL, NOT LOOKED UP. An agent holds one of these, wraps each of its
 * tools with {@link withinNativeRun}, and hands it to {@link nativeApprovalRun}, which puts the run
 * in it when the run starts. A tool then re-enters exactly that run, however the call reached it.
 * An agent runs one run at a time (a built-in agent refuses a second while one is open), so the run
 * a tool finds is the one that called it by construction. Looking the run up by the call's id
 * instead matched across every person's open runs, and call ids are not unique: two runs numbering
 * their calls alike could fail a call, or ask in another person's conversation.
 */
export type NativeRunScope = { run?: NativeRun };
export const nativeRunScope = (): NativeRunScope => ({});

/** A tool's execute, re-entering the run its agent is in when it is called. */
export function withinNativeRun<A extends unknown[], R>(
  scope: NativeRunScope,
  execute: (...args: A) => R,
): (...args: A) => R {
  return (...args) => {
    const run = scope.run;
    // Only the agent's own run calls its tools, so a call with none has no conversation to ask in.
    if (!run)
      throw new Error(
        "This tool call is not part of a conversation, so it was not run.",
      );
    return nativeRuns.run(run, () => execute(...args));
  };
}

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
  const pending = Promise.resolve().then(() =>
    withApprovalContext(continuation, execute),
  );
  run.pending.add(pending);
  try {
    return await pending;
  } catch (error) {
    if (error instanceof HeadlessToolSuspension && !run.waiting) {
      run.waiting = error;
      await run.suspend(error);
    }
    throw error;
  } finally {
    run.pending.delete(pending);
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
  constructor(private readonly scope?: NativeRunScope) {
    super();
  }
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
        pending: new Set(),
        abort: () => subscriber.complete(),
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
        async suspend(error) {
          // Stop the provider, then let every call it already started settle before ending the run.
          // Unsubscribing alone cannot cancel a database transaction: another call may still be
          // opening an approval. A subagent withdraws those requests after this terminal event.
          subscription?.unsubscribe();
          await Promise.allSettled(run.pending);
          if (subscriber.closed) return;
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
        },
      };
      // Kept after the run ends: a call still arriving belongs to it, and finds it waiting or done.
      if (this.scope) this.scope.run = run;
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
  /** Where this run is put for the agent's tools to find. See {@link NativeRunScope}. */
  scope?: NativeRunScope,
) {
  return new NativeApprovalMiddleware(scope).run(
    input,
    new NativeStream(source, input),
  );
}
