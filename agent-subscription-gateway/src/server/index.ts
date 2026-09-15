import type { AgentDriver } from "../drivers/agent-driver";
import type { RunCounts } from "../observability/run-counts";
import type { RunLogger } from "../observability/run-logger";
import { createGatewayHandler, type GatewayRunService } from "./app";

export interface ServeGatewayOptions {
  port: number;
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

export function serveGateway(options: ServeGatewayOptions) {
  const fetch = createGatewayHandler(options);
  return Bun.serve({ port: options.port, idleTimeout: 120, fetch });
}

export { createGatewayHandler } from "./app";
