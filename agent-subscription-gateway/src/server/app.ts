import type { AgentDriver } from "../drivers/agent-driver";
import { InMemoryRunCounts, type RunCounts } from "../observability/run-counts";
import { consoleRunLogger, type RunLogger } from "../observability/run-logger";
import { gatewayStatus } from "../observability/status";
import { hasManagedAgentToken } from "../../../shared/agent-authorisation";
import { gatewayRunInput, type GatewayRunInput } from "./input";
import { runAgent } from "./run-agent";

export interface GatewayRunService {
  readonly counts: RunCounts;
  respond(input: GatewayRunInput, signal: AbortSignal): Response;
}

export interface GatewayOptions {
  token: string;
  driver: AgentDriver;
  counts?: RunCounts;
  logger?: RunLogger;
  resolveSessionId?: (
    runId: string,
    threadId: string,
  ) => Promise<string | undefined>;
  runService?: GatewayRunService;
}

export function createGatewayHandler(options: GatewayOptions) {
  if (!options.token.trim()) {
    throw new Error("The gateway token must not be empty.");
  }
  const counts =
    options.counts ?? options.runService?.counts ?? new InMemoryRunCounts();
  const logger = options.logger ?? consoleRunLogger;

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json(
        await gatewayStatus(options.driver, counts, "health"),
      );
    }

    if (url.pathname === "/ready" && request.method === "GET") {
      const status = await gatewayStatus(options.driver, counts, "ready");
      return Response.json(status, { status: status.authReady ? 200 : 503 });
    }

    if (url.pathname === "/ag-ui" && request.method === "POST") {
      if (!hasManagedAgentToken(request, options.token)) {
        return Response.json({ error: "Unauthorized." }, { status: 401 });
      }

      let rawInput: unknown;
      try {
        rawInput = await request.json();
      } catch {
        return Response.json(
          { error: "Invalid AG-UI request." },
          { status: 400 },
        );
      }
      const input = gatewayRunInput(rawInput);
      if (!input) {
        return Response.json(
          { error: "Invalid AG-UI request." },
          { status: 400 },
        );
      }
      if (input.tools.length > 0) {
        return Response.json(
          {
            error:
              "OpenBot tool grants are not accepted by subscription workers.",
          },
          { status: 400 },
        );
      }

      if (options.runService) {
        return options.runService.respond(input, request.signal);
      }

      const sessionId = await options.resolveSessionId?.(
        input.runId,
        input.threadId,
      );
      return runAgent({
        input,
        driver: options.driver,
        counts,
        logger,
        requestSignal: request.signal,
        ...(sessionId ? { sessionId } : {}),
      });
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  };
}
