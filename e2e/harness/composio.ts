import { join } from "node:path";
import type { PlaywrightTestConfig } from "@playwright/test";
import { COMPOSIO_URL, E2E, LOGS, ROOT } from "./config";

/**
 * The Composio stub (`composio-stub.ts`), as one of Playwright's web servers: up before the stack,
 * so the server's Composio client never reaches the real one, and stopped after the last journey.
 */

export const COMPOSIO_STUB_LOG = join(LOGS, "composio-stub.log");

type WebServer = Exclude<
  NonNullable<PlaywrightTestConfig["webServer"]>,
  unknown[]
>;

export function composioStubServer(): WebServer {
  const server = join(E2E, "harness", "composio-stub.ts");
  return {
    name: "composio-stub",
    command: `set -o pipefail; bun --no-env-file "${server}" 2>&1 | tee "${COMPOSIO_STUB_LOG}"`,
    cwd: ROOT,
    url: `${COMPOSIO_URL}/__stub/health`,
    // Never a real Composio or somebody else's stub: a server already on this port fails the run.
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
    timeout: 30_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  };
}
