import {
  type AgentDriver,
  type DriverEvent,
  type DriverRun,
  type DriverResumeRun,
  SafeDriverError,
} from "../drivers/agent-driver";
import type { RunCounts } from "../observability/run-counts";
import type { RunLogger } from "../observability/run-logger";
import type { GatewayRunInput } from "./input";
import { type AgUiEvent, encodeSse, SSE_HEADERS } from "./sse";

class CancelledRun extends Error {}

function safeFailure(error: unknown): string {
  return error instanceof SafeDriverError
    ? error.publicMessage
    : "The provider run failed.";
}

async function nextOrCancel<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) throw new CancelledRun();

  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const cancelled = () => reject(new CancelledRun());
    signal.addEventListener("abort", cancelled, { once: true });
    iterator.next().then(
      (result) => {
        signal.removeEventListener("abort", cancelled);
        if (signal.aborted) reject(new CancelledRun());
        else resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", cancelled);
        reject(error);
      },
    );
  });
}

export function runAgent(options: {
  input: GatewayRunInput;
  driver: AgentDriver;
  counts: RunCounts;
  logger: RunLogger;
  requestSignal: AbortSignal;
  sessionId?: string;
  onSession?: (sessionId: string) => void | Promise<void>;
  beforeTerminal?: (
    outcome: "finished" | "failed" | "cancelled",
  ) => void | Promise<void>;
}): Response {
  const {
    input,
    driver,
    counts,
    logger,
    requestSignal,
    sessionId,
    onSession,
    beforeTerminal,
  } = options;
  const run: DriverRun = {
    threadId: input.threadId,
    runId: input.runId,
    messages: input.messages,
    context: input.context,
    state: input.state,
    forwardedProps: input.forwardedProps,
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
  };
  const driverController = new AbortController();
  let cancelPromise: Promise<void> | undefined;
  const cancel = () => {
    if (cancelPromise) return cancelPromise;
    driverController.abort();
    cancelPromise = driver.cancel(input.runId).catch(() => undefined);
    return cancelPromise;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: AgUiEvent) => controller.enqueue(encodeSse(event));
      const pump = async () => {
        counts.started();
        let messageIndex = 0;
        let messageOpen = false;
        const messageId = () => `msg_${input.runId}_${messageIndex}`;
        const closeMessage = () => {
          if (!messageOpen) return;
          send({ type: "TEXT_MESSAGE_END", messageId: messageId() });
          messageOpen = false;
          messageIndex += 1;
        };
        const onRequestAbort = () => void cancel();
        requestSignal.addEventListener("abort", onRequestAbort, { once: true });

        send({
          type: "RUN_STARTED",
          threadId: input.threadId,
          runId: input.runId,
        });

        let outcome: "finished" | "failed" | "cancelled" = "failed";
        let iterator: AsyncIterator<DriverEvent> | undefined;
        try {
          const context = { signal: driverController.signal };
          const events = sessionId
            ? driver.resume(
                { ...run, sessionId } satisfies DriverResumeRun,
                context,
              )
            : driver.start(run, context);
          iterator = events[Symbol.asyncIterator]();

          while (true) {
            const next = await nextOrCancel(iterator, driverController.signal);
            if (next.done) break;
            const event = next.value;
            if (event.type === "session") {
              await onSession?.(event.sessionId);
              continue;
            }
            if (event.type === "text") {
              if (!event.delta) continue;
              if (!messageOpen) {
                send({
                  type: "TEXT_MESSAGE_START",
                  messageId: messageId(),
                  role: "assistant",
                });
                messageOpen = true;
              }
              send({
                type: "TEXT_MESSAGE_CONTENT",
                messageId: messageId(),
                delta: event.delta,
              });
              continue;
            }
            if (event.type === "activity") {
              closeMessage();
              send({
                type: "CUSTOM",
                name: "subscription_agent_activity",
                value: {
                  provider: driver.provider,
                  message: event.message,
                  ...(event.data ? { data: event.data } : {}),
                },
              });
              continue;
            }
            throw new Error("Unsupported driver event.");
          }

          if (driverController.signal.aborted) throw new CancelledRun();
          closeMessage();
          await beforeTerminal?.("finished");
          send({
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          });
          outcome = "finished";
        } catch (error) {
          closeMessage();
          if (
            error instanceof CancelledRun ||
            driverController.signal.aborted
          ) {
            await cancel();
            await beforeTerminal?.("cancelled");
            send({ type: "RUN_ERROR", message: "The run was cancelled." });
            outcome = "cancelled";
          } else {
            await beforeTerminal?.("failed");
            send({ type: "RUN_ERROR", message: safeFailure(error) });
            outcome = "failed";
          }
        } finally {
          requestSignal.removeEventListener("abort", onRequestAbort);
          if (outcome === "cancelled") void iterator?.return?.();
          counts.finished();
          logger.terminal({
            provider: driver.provider,
            runId: input.runId,
            outcome,
          });
          controller.close();
        }
      };

      void pump();
    },
    cancel() {
      return cancel();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
