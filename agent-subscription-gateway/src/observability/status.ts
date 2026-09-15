import type { AgentDriver } from "../drivers/agent-driver";
import type { RunCounts } from "./run-counts";

export interface GatewayStatus {
  status: "ok" | "ready" | "not_ready";
  provider: string;
  version: string;
  authReady: boolean;
  queueDepth: number;
  activeRuns: number;
}

export async function gatewayStatus(
  driver: AgentDriver,
  counts: RunCounts,
  route: "health" | "ready",
): Promise<GatewayStatus> {
  const authReady = await driver.isAuthReady().catch(() => false);
  const current = counts.snapshot();
  return {
    status: route === "health" ? "ok" : authReady ? "ready" : "not_ready",
    provider: driver.provider,
    version: driver.version,
    authReady,
    queueDepth: current.queueDepth,
    activeRuns: current.activeRuns,
  };
}
