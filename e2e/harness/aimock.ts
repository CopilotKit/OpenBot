import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PlaywrightTestConfig } from "@playwright/test";
import {
  AIMOCK_URL,
  E2E,
  LOGS,
  RECORDING,
  RECORDING_DIR,
  ROOT,
} from "./config";

/**
 * aimock, as one of Playwright's web servers: started before any project, stopped after the last.
 * The server itself is `aimock-server.ts`.
 *
 * REPLAY (the default) IS STRICT. A request that no fixture answers is refused with a 503, which
 * reaches the person as a failed answer, and the journal check in `test.ts` fails the test that
 * caused it, naming the request. Proxy-only mode is never used: it would quietly send a miss to the
 * real provider and pass.
 *
 * RECORD (`E2E_RECORD=1`) loads no fixtures, so every request goes to the real provider and is
 * saved. The real key goes to aimock alone, as its provider key, and aimock swaps it in for
 * OpenBot's `sk-aimock-` dummy key on the way out. OpenBot never holds it, and it is never on a
 * command line, in this config or in a log. `test.ts` files each test's recordings under
 * `e2e/fixtures/<journey>/` when the test ends.
 */

export const AIMOCK_LOG = join(LOGS, "aimock.log");

type WebServer = Exclude<
  NonNullable<PlaywrightTestConfig["webServer"]>,
  unknown[]
>;

export function aimockServer(): WebServer {
  mkdirSync(LOGS, { recursive: true });
  if (RECORDING) {
    rmSync(RECORDING_DIR, { recursive: true, force: true });
    mkdirSync(RECORDING_DIR, { recursive: true });
  }
  const server = join(E2E, "harness", "aimock-server.ts");
  return {
    name: "aimock",
    // `tee`, so the whole log is kept for the NO FIXTURE MATCH count after the run.
    command: `set -o pipefail; bun --no-env-file "${server}" 2>&1 | tee "${AIMOCK_LOG}"`,
    cwd: ROOT,
    url: `${AIMOCK_URL}/__aimock/health`,
    // Never someone else's aimock: a server already on this port fails the run instead.
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
    timeout: 30_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  };
}
