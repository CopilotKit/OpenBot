import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Everything the end-to-end run needs to know about where things are, in one place.
 *
 * THE RUN OWNS ITS OWN STACK. Its own compose project and its own block of ports (46xxx), so a
 * stack somebody already has running (OpenBot Desktop on 3001/3010/5432, a dev stack, another
 * worktree) is never reused, restarted or stopped by it. Each run brings that stack up fresh
 * through `scripts/start.sh`, with a new database, so every journey starts where a new person does.
 */

// `__dirname`, not `import.meta`: Playwright loads this config as CommonJS (the root package.json
// has no "type": "module"), and Bun, which runs aimock-server.ts, provides it too.
export const ROOT = resolve(__dirname, "../..");
export const E2E = join(ROOT, "e2e");
/** Gitignored. Screenshots, logs, the Playwright report and traces. */
export const ARTIFACTS = join(E2E, ".artifacts");
export const SCREENSHOTS = join(ARTIFACTS, "screenshots");
export const LOGS = join(ARTIFACTS, "logs");
/** Recorded fixtures, one directory per journey. */
export const FIXTURES = join(E2E, "fixtures");

/**
 * A second run on the same machine, from another checkout, gets a stack of its own with
 * `E2E_PORT_OFFSET=1000` (or 2000, …): every port below moves up by it, and the compose project is
 * `openbot-e2e-1000`, so neither run sees, reuses or stops the other's stack. A multiple of 1000,
 * so one run's ports never land on another's. Unset, the run is on 46xxx in `openbot-e2e`.
 */
const PORT_OFFSET = portOffset(process.env.E2E_PORT_OFFSET);

function portOffset(value: string | undefined): number {
  if (!value) return 0;
  const offset = Number(value);
  if (!Number.isInteger(offset) || offset < 0 || offset % 1000 !== 0) {
    throw new Error(
      `E2E_PORT_OFFSET must be a multiple of 1000, such as 1000 or 2000; it is "${value}".`,
    );
  }
  return offset;
}

export const COMPOSE_PROJECT = PORT_OFFSET
  ? `openbot-e2e-${PORT_OFFSET}`
  : "openbot-e2e";

export const PORTS = {
  server: 46001 + PORT_OFFSET,
  app: 46010 + PORT_OFFSET,
  computer: 46100 + PORT_OFFSET,
  browser: 46101 + PORT_OFFSET,
  bot: 46200 + PORT_OFFSET,
  langgraph: 46201 + PORT_OFFSET,
  aimock: 46400 + PORT_OFFSET,
  composio: 46410 + PORT_OFFSET,
  postgres: 46432 + PORT_OFFSET,
  supervisor: 46500 + PORT_OFFSET,
} as const;

/**
 * Where the run's own stand-ins listen (aimock, the Composio stub, the test site). Loopback, which is
 * where Docker Desktop and Podman on a Mac carry `host.docker.internal` from the server's container.
 * A Linux engine reaches this machine at its bridge address instead, so CI there names every
 * interface (`E2E_BIND_HOST=0.0.0.0`) on a runner nothing else can reach.
 */
export const BIND_HOST = process.env.E2E_BIND_HOST?.trim() || "127.0.0.1";

export const APP_URL = `http://127.0.0.1:${PORTS.app}`;
export const SERVER_URL = `http://127.0.0.1:${PORTS.server}`;
export const AIMOCK_URL = `http://127.0.0.1:${PORTS.aimock}`;
/** Where aimock serves the MCP server a journey adds by its address (`harness/aimock-server.ts`). */
export const MCP_SERVER_PATH = "/mcp/field-notes";
export const MCP_SERVER_URL = `${AIMOCK_URL}${MCP_SERVER_PATH}`;
/** The stand-in for Composio's API (`harness/composio-stub.ts`). OpenBot's Composio client is built against it. */
export const COMPOSIO_URL = `http://127.0.0.1:${PORTS.composio}`;

/**
 * Replay is the default and is strict: a request no fixture answers fails the run. Record mode
 * (`bun run test:e2e:record`) proxies to the real providers with the key in `.env` and saves what
 * they answer as fixtures.
 */
export const RECORDING = process.env.E2E_RECORD === "1";

/**
 * The key OpenBot is given. aimock answers in replay; in record mode aimock swaps any caller key
 * that starts with `sk-aimock-` for the real one it holds, so OpenBot never sees a real key.
 */
export const DUMMY_OPENAI_KEY = "sk-aimock-openbot-e2e";
export const DUMMY_ANTHROPIC_KEY = "sk-aimock-openbot-e2e";
/** The Composio key OpenBot is given. Only the stub ever reads it; the real Composio never sees a request. */
export const DUMMY_COMPOSIO_KEY = "openbot-e2e-composio-stub";

/** A value from the checkout's `.env`, without echoing anything else in it. */
export function dotenvValue(name: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(ROOT, ".env"), "utf8");
  } catch {
    return undefined;
  }
  let found: string | undefined;
  for (const line of text.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== name) continue;
    found = match[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return found?.trim() || undefined;
}

/** Where aimock writes recordings in record mode, before `test.ts` files them under a journey. */
export const RECORDING_DIR = join(ARTIFACTS, "recording");

/** Each journey's fixture directory, loaded as its own set in replay. */
export function fixtureDirectories(): string[] {
  if (!existsSync(FIXTURES)) return [];
  return readdirSync(FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(FIXTURES, entry.name));
}
