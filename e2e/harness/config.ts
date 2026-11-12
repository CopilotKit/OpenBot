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

export const COMPOSE_PROJECT = "openbot-e2e";

export const PORTS = {
  server: 46001,
  app: 46010,
  computer: 46100,
  browser: 46101,
  bot: 46200,
  langgraph: 46201,
  aimock: 46400,
  postgres: 46432,
  supervisor: 46500,
} as const;

export const APP_URL = `http://127.0.0.1:${PORTS.app}`;
export const SERVER_URL = `http://127.0.0.1:${PORTS.server}`;
export const AIMOCK_URL = `http://127.0.0.1:${PORTS.aimock}`;

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
