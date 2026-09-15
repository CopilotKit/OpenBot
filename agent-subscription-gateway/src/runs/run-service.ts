import type { AgentDriver } from "../drivers/agent-driver";
import type { RunLogger } from "../observability/run-logger";
import type { GatewayRunService } from "../server/app";
import type { GatewayRunInput } from "../server/input";
import { runAgent } from "../server/run-agent";
import { encodeSse, SSE_HEADERS } from "../server/sse";
import type { RunState, RunStore, StoredRun } from "../storage/run-store";
import type {
  WorkspaceLease,
  WorkspaceManager,
  WorkspaceResult,
} from "../workspaces/workspace-manager";
import { type BoundedRunQueue, CapacityError } from "./queue";
import { prepareProviderRun } from "./session-input";

const RESTART_ERROR = "Gateway restarted; submit a new run.";

interface WorkspaceOperations {
  create(runId: string): Promise<WorkspaceLease>;
  captureResult(workspace: WorkspaceLease): Promise<WorkspaceResult>;
}

function priorRun(run: StoredRun) {
  return {
    provider: run.provider,
    runId: run.runId,
    threadId: run.threadId,
    state: run.state,
    ...(run.errorSummary ? { error: run.errorSummary } : {}),
    resultAvailable: run.patch !== undefined,
  };
}

function safeSetupFailure(error: unknown): string {
  if (error instanceof CapacityError) return error.message;
  return "The run could not be prepared.";
}

function mergeSignals(first: AbortSignal, second: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === "function")
    return AbortSignal.any([first, second]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  first.addEventListener("abort", abort, { once: true });
  second.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

export class RunService implements GatewayRunService {
  readonly counts: BoundedRunQueue;
  private readonly provider: string;

  constructor(
    private readonly options: {
      driver: AgentDriver;
      store: RunStore;
      queue: BoundedRunQueue;
      workspaces: WorkspaceOperations | WorkspaceManager;
      logger: RunLogger;
    },
  ) {
    this.provider = options.driver.provider;
    this.counts = options.queue;
    options.store.recoverInterrupted(RESTART_ERROR, this.provider);
  }

  respond(input: GatewayRunInput, requestSignal: AbortSignal): Response {
    const reservation = this.options.store.reserveRun({
      provider: this.provider,
      runId: input.runId,
      threadId: input.threadId,
    });
    if (!reservation.created) {
      return Response.json(
        {
          error: "This provider run ID was already submitted.",
          retryable: false,
          run: priorRun(reservation.run),
        },
        { status: 409 },
      );
    }

    const connection = new AbortController();
    const signal = mergeSignals(requestSignal, connection.signal);
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      streamController.close();
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        connection.abort();
      },
    });

    try {
      const completion = this.options.queue.enqueue({
        runId: input.runId,
        signal,
        onHeartbeat: () => {
          if (!closed)
            streamController.enqueue(
              new TextEncoder().encode(": heartbeat\n\n"),
            );
        },
        run: () => this.execute(input, signal, streamController),
      });
      void completion.then(close, (error) => {
        this.failInterrupted(input.runId, safeSetupFailure(error));
        if (!closed && !signal.aborted) {
          streamController.enqueue(
            encodeSse({ type: "RUN_ERROR", message: safeSetupFailure(error) }),
          );
        }
        close();
      });
    } catch (error) {
      this.failInterrupted(input.runId, safeSetupFailure(error));
      close();
      if (error instanceof CapacityError) {
        return Response.json(
          { error: error.message, retryable: true },
          { status: 429, headers: { "retry-after": "5" } },
        );
      }
      throw error;
    }

    return new Response(stream, { headers: SSE_HEADERS });
  }

  private async execute(
    input: GatewayRunInput,
    signal: AbortSignal,
    output: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    let workspace: WorkspaceLease | undefined;
    this.options.store.transitionRun(this.provider, input.runId, "preparing", [
      "queued",
    ]);
    try {
      const activeWorkspace = await this.options.workspaces.create(input.runId);
      workspace = activeWorkspace;
      this.options.store.attachWorkspace(
        this.provider,
        input.runId,
        workspace.path,
      );
      const prepared = prepareProviderRun(
        this.options.store,
        this.provider,
        input.threadId,
        input.messages,
      );
      this.options.store.transitionRun(this.provider, input.runId, "running", [
        "preparing",
      ]);
      let providerSessionId = prepared.sessionId;
      let terminalRecorded = false;
      const response = runAgent({
        input: {
          ...input,
          messages: prepared.messages,
          workspacePath: workspace.path,
        },
        driver: this.options.driver,
        counts: this.options.queue,
        logger: this.options.logger,
        requestSignal: signal,
        ...(prepared.sessionId ? { sessionId: prepared.sessionId } : {}),
        onSession: (sessionId) => {
          providerSessionId = sessionId;
        },
        beforeTerminal: async (outcome) => {
          if (terminalRecorded) return;
          try {
            const result =
              await this.options.workspaces.captureResult(activeWorkspace);
            this.options.store.saveResult(this.provider, input.runId, result);
          } catch (error) {
            if (outcome === "finished") throw error;
          }
          if (outcome === "finished" && providerSessionId) {
            this.options.store.acknowledgeRun({
              provider: this.provider,
              runId: input.runId,
              sessionId: providerSessionId,
              ...(prepared.acknowledgedMessageId
                ? { acknowledgedMessageId: prepared.acknowledgedMessageId }
                : {}),
            });
          }
          const next: RunState =
            outcome === "finished"
              ? "completed"
              : outcome === "cancelled"
                ? "cancelled"
                : "failed";
          this.options.store.transitionRun(
            this.provider,
            input.runId,
            next,
            outcome === "finished" ? ["running"] : ["running", "cancelling"],
          );
          terminalRecorded = true;
        },
      });
      if (!response.body)
        throw new Error("The provider stream did not have a body.");
      const reader = response.body.getReader();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        output.enqueue(part.value);
      }
    } catch (error) {
      const current = this.options.store.getRun(this.provider, input.runId);
      if (
        current &&
        ["queued", "preparing", "running", "cancelling"].includes(current.state)
      ) {
        this.failInterrupted(input.runId, safeSetupFailure(error));
      }
      throw error;
    }
  }

  private failInterrupted(runId: string, summary: string): void {
    const current = this.options.store.getRun(this.provider, runId);
    if (
      !current ||
      !["queued", "preparing", "running", "cancelling"].includes(current.state)
    ) {
      return;
    }
    this.options.store.transitionRun(
      this.provider,
      runId,
      "failed",
      [current.state],
      {
        errorSummary: summary,
      },
    );
  }
}
