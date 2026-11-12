import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/**
 * The settings `scripts/start.sh` starts the server's container with: `.env`, with whatever the
 * environment sets winning over it.
 *
 * That is the order the server always read them in when it ran on the host, `bun --env-file=../.env`
 * with the script's own exports on top, and the order everything else in start.sh reads them in.
 * A container is handed only what is named for it, so this writes the result to a file Compose reads
 * (`OPENBOT_SERVER_ENV_FILE` in docker-compose.yml). `environment:` there still wins over the file,
 * which is how the server is given container addresses rather than the host's loopback.
 *
 * WHICH SETTINGS: every one `.env` has, every one `.env.example` and `.env.personal.example` list,
 * and the few below that are set for a run rather than written down. An exported value counts even
 * when it is empty, as it did for Bun: that is how a run switches a `.env` setting off.
 *
 *     bun scripts/server-env.ts <.env> <output>
 */

/** Read for a run from the environment, and listed in neither template. */
const RUN_SETTINGS = [
  "OPENBOT_EDITION",
  "OPENBOT_ONE_COMPUTER_EACH",
  "OPENBOT_BROKER_PROVIDER",
  "OPENBOT_MODEL_CAPABILITIES_URL",
  "OPENBOT_ALLOW_LOOPBACK_MCP",
  "ARCADE_API_KEY",
  "COMPOSIO_BASE_URL",
  "DO_NOT_TRACK",
  "COPILOTKIT_TELEMETRY_DISABLED",
];

/**
 * Endpoints the server dials that Compose gives no container address of their own (it does for
 * OpenAI's, Intelligence's and the picked harness's, which start.sh sets). A loopback address names
 * the container itself in there, so it is written as this machine: `host.docker.internal`.
 */
const DIALLED_ON_THIS_MACHINE = [
  "ANTHROPIC_BASE_URL",
  "COMPOSIO_BASE_URL",
  "GOOGLE_GENERATIVE_AI_BASE_URL",
  "TRANSCRIPTION_BASE_URL",
];

/** A loopback URL as the server's container reaches it. Anything else is returned as it is. */
export function onThisMachine(value: string): string {
  return value.replace(
    /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/,
    "$1host.docker.internal",
  );
}

const ROOT = join(import.meta.dir, "..");
const SETTING = /^\s*#?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/;

/** The setting names a template lists, written or commented out. */
function listed(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => SETTING.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * One line Compose's env file reader takes literally. Single quotes are read as written; double
 * quotes, for a value with a single quote in it, as long as nothing in it would be read as an escape
 * or a variable. Anything else is refused by name rather than handed over changed.
 */
export function envLine(name: string, value: string): string {
  if (!/[\r\n']/.test(value)) return `${name}='${value}'`;
  if (!/[\r\n"$\\`]/.test(value)) return `${name}="${value}"`;
  throw new Error(
    `${name} has a value the server's container cannot be given as written (a line break, or a single quote beside a ", $, \\ or \`). Write it without them in .env.`,
  );
}

export function serverEnvironment(
  dotenv: string,
  environment: Record<string, string | undefined>,
  templates: string[],
): string {
  const values = parseEnv(dotenv);
  const names = [
    ...new Set([...Object.keys(values), ...templates, ...RUN_SETTINGS]),
  ];
  const lines: string[] = [];
  for (const name of names) {
    const value =
      environment[name] !== undefined ? environment[name] : values[name];
    if (value === undefined) continue;
    lines.push(
      envLine(
        name,
        DIALLED_ON_THIS_MACHINE.includes(name) ? onThisMachine(value) : value,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const [dotenvPath, outputPath] = process.argv.slice(2);
  if (!dotenvPath || !outputPath) {
    console.error("Usage: bun scripts/server-env.ts <.env> <output>");
    process.exit(2);
  }
  const templates = [
    ...listed(join(ROOT, ".env.example")),
    ...listed(join(ROOT, ".env.personal.example")),
  ];
  writeFileSync(
    outputPath,
    serverEnvironment(readFileSync(dotenvPath, "utf8"), process.env, templates),
    { mode: 0o600 },
  );
}
