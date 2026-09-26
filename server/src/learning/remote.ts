import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type MessagesSnapshotEvent,
  Middleware,
  type RunAgentInput,
  type RunFinishedEvent,
  type ToolCall,
} from "@ag-ui/client";
import { map, Observable, type Subscription } from "rxjs";
import type { AcquireLearnedSkills } from "./runtime";

const CATALOG_ID = "openbot:learned-skills";
const CATALOG_CONTEXT = "OpenBot learned skills";
const RESERVED_TOOLS = new Set([
  "copilotkit_load_skill",
  "copilotkit_read_skill_file",
]);
const MAX_SKILL_STEPS = 10;

/**
 * Remote frameworks use their normal AG-UI client-tool boundary for skill reads.
 * The snapshot and Intelligence credential remain on this server. A continuation
 * calls the same transport with the captured catalog, tool results and state;
 * only a new outer invocation acquires a new snapshot.
 */
export class RemoteLearnedSkillsMiddleware extends Middleware {
  constructor(
    private readonly agentId: string,
    private readonly acquire: AcquireLearnedSkills,
  ) {
    super();
  }

  run(
    originalInput: RunAgentInput,
    next: AbstractAgent,
  ): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      // Snapshot-emitting frameworks can replay our prior system message.
      // Remove it even when delivery was disabled after that invocation.
      const input = {
        ...originalInput,
        messages: originalInput.messages.filter(
          (message) => message.id !== CATALOG_ID,
        ),
        context: originalInput.context.filter(
          (entry) => entry.description !== CATALOG_CONTEXT,
        ),
      };
      const controller = new AbortController();
      let subscription: Subscription | undefined;
      let started = false;
      const work = async () => {
        const invocation = await this.acquire(this.agentId, controller.signal);
        if (subscriber.closed) return;
        const tools = new Set(invocation?.tools.map((tool) => tool.name) ?? []);
        const checkAvailability = skillAvailabilityCheck(tools, input.messages);
        if (!invocation) {
          await new Promise<void>((resolve, reject) => {
            subscription = this.runNext(input, next)
              .pipe(
                map((event) => {
                  checkAvailability(event);
                  return event;
                }),
              )
              .subscribe({
                next: (event) => subscriber.next(event),
                error: reject,
                complete: resolve,
              });
          });
          return;
        }
        if (input.tools.some((tool) => RESERVED_TOOLS.has(tool.name))) {
          throw new Error("Automatic Learning tool names are reserved.");
        }
        let request: RunAgentInput = {
          ...input,
          messages: [
            ...(invocation.catalog
              ? [
                  {
                    id: CATALOG_ID,
                    role: "system" as const,
                    content: invocation.catalog,
                  },
                ]
              : []),
            ...input.messages.filter((message) => message.id !== CATALOG_ID),
          ],
          context: [
            ...input.context.filter(
              (entry) => entry.description !== CATALOG_CONTEXT,
            ),
            ...(invocation.catalog
              ? [{ description: CATALOG_CONTEXT, value: invocation.catalog }]
              : []),
          ],
          tools: [...input.tools, ...invocation.tools],
        };
        for (let step = 0; step <= MAX_SKILL_STEPS; step += 1) {
          if (subscriber.closed) return;
          const emitted = new Set<string>();
          const previousCalls = new Set(
            request.messages.flatMap((message) =>
              message.role === "assistant"
                ? (message.toolCalls ?? []).map((call) => call.id)
                : [],
            ),
          );
          let messages: Message[] = request.messages;
          let state: unknown = request.state;
          let terminal: RunFinishedEvent | undefined;
          let failed = false;
          await new Promise<void>((resolve, reject) => {
            subscription = this.runNextWithState(
              request,
              new InvocationTransport(next, request),
            )
              .pipe(
                map((current) => {
                  checkAvailability(current.event);
                  return current;
                }),
              )
              .subscribe({
                next: ({
                  event,
                  messages: currentMessages,
                  state: currentState,
                }) => {
                  messages = currentMessages;
                  state = currentState;
                  // CrewAI publishes complete calls in message snapshots instead
                  // of individual tool events. Only newly produced calls belong
                  // to this segment; never replay a historical unanswered call.
                  if (event.type === EventType.MESSAGES_SNAPSHOT) {
                    for (const message of currentMessages) {
                      if (message.role !== "assistant") continue;
                      for (const call of message.toolCalls ?? []) {
                        if (!previousCalls.has(call.id)) emitted.add(call.id);
                      }
                    }
                  }
                  if (event.type === EventType.TOOL_CALL_START) {
                    emitted.add(String(event.toolCallId));
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
          if (!terminal)
            throw new Error("Remote agent ended without a terminal event.");
          const answered = new Set(
            messages.flatMap((message) =>
              message.role === "tool" ? [message.toolCallId] : [],
            ),
          );
          const pending: ToolCall[] = messages.flatMap((message) =>
            message.role === "assistant"
              ? (message.toolCalls ?? []).filter(
                  (call) => emitted.has(call.id) && !answered.has(call.id),
                )
              : [],
          );
          const reads = pending.filter((call) => tools.has(call.function.name));
          if (reads.length === 0) {
            subscriber.next(terminal);
            return;
          }
          if (step === MAX_SKILL_STEPS)
            throw new Error("Automatic Learning tool step limit reached.");
          const results = new Map<string, string>();
          for (const call of reads) {
            if (subscriber.closed) return;
            const content = await invocation.execute(
              call.function.name,
              JSON.parse(call.function.arguments || "{}"),
            );
            if (subscriber.closed) return;
            const message: Message = {
              id: crypto.randomUUID(),
              role: "tool",
              toolCallId: call.id,
              content,
            };
            messages = [...messages, message];
            results.set(call.id, content);
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
          const unansweredInterrupts = interrupts.filter(
            (interrupt) => !results.has(interrupt.toolCallId ?? interrupt.id),
          );
          // A UI or governed tool still belongs to its existing executor. Return
          // the boundary with our reads answered, without inventing its result.
          if (
            reads.length !== pending.length ||
            unansweredInterrupts.length > 0
          ) {
            subscriber.next(
              unansweredInterrupts.length > 0
                ? {
                    ...terminal,
                    outcome: {
                      type: "interrupt",
                      interrupts: unansweredInterrupts,
                    },
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
      void work().then(
        () => {
          if (!subscriber.closed) subscriber.complete();
        },
        (error: unknown) => {
          if (subscriber.closed) return;
          subscriber.next({
            type: EventType.RUN_ERROR,
            code: "OPENBOT_LEARNED_SKILLS_ERROR",
            message:
              error instanceof Error
                ? error.message
                : "Automatic Learning delivery failed.",
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

/** AG-UI accumulates from the agent's initial history, not input.messages. */
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

/** Retained native queries can still call a tool removed between UI segments. */
function skillAvailabilityCheck(offered: Set<string>, history: Message[]) {
  const answered = new Set(
    history.flatMap((message) =>
      message.role === "tool" ? [message.toolCallId] : [],
    ),
  );
  const check = (name: string, id: string) => {
    if (RESERVED_TOOLS.has(name) && !offered.has(name) && !answered.has(id)) {
      throw new Error(
        "Automatic Learning is unavailable for this run. Start a new message to continue without learned skills.",
      );
    }
  };
  return (event: BaseEvent) => {
    if (event.type === EventType.TOOL_CALL_RESULT)
      answered.add(String(event.toolCallId));
    if (event.type === EventType.TOOL_CALL_START) {
      check(String(event.toolCallName), String(event.toolCallId));
    }
    if (event.type === EventType.MESSAGES_SNAPSHOT) {
      const messages = (event as MessagesSnapshotEvent).messages;
      for (const message of messages) {
        if (message.role === "tool") answered.add(message.toolCallId);
      }
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        for (const call of message.toolCalls ?? [])
          check(call.function.name, call.id);
      }
    }
  };
}
