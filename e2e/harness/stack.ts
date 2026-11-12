import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AIMOCK_URL,
  APP_URL,
  ARTIFACTS,
  COMPOSE_PROJECT,
  COMPOSIO_URL,
  DUMMY_ANTHROPIC_KEY,
  DUMMY_COMPOSIO_KEY,
  LOGS,
  PORTS,
  ROOT,
  SERVER_URL,
} from "./config";

/**
 * The stack the run drives: the real OpenBot, brought up by `scripts/start.sh`, the same script a
 * developer runs, in the personal edition (one person, no sign-in, the Personal Assistant).
 *
 * What makes it the run's own, rather than whatever is already on this machine:
 *
 * - its own compose project (`openbot-e2e`), so its containers and volumes are separate, and its
 *   own image tags, so building it never replaces an image another stack runs;
 * - its own ports (46xxx), so OpenBot Desktop or a dev stack on the defaults is never touched;
 * - a fresh database every run (`down -v` first), so a journey starts where a new person does.
 *
 * Settings go in through the environment. `start.sh` and the server read the environment before
 * `.env` (Bun keeps an exported value over the file's), so the developer's `.env` supplies only what
 * is not set here: the Intelligence licence and the encryption key.
 */

const STATE = join(ARTIFACTS, "stack.json");
export const START_LOG = join(LOGS, "start.log");
/** The API server's own log, which start.sh writes into OPENBOT_LOG_DIR. */
export const SERVER_LOG = join(LOGS, "server.log");

/** Fixed per-run secrets, so start.sh never generates one and never writes to `.env`. */
const E2E_SECRETS = {
  MANAGED_AGENT_TOKEN: "openbot-e2e-managed-agent-token",
  AGENT_TOOL_TOKEN: "openbot-e2e-agent-tool-token",
  COMPUTER_TOKEN: "openbot-e2e-computer-token",
  SUPERVISOR_TOKEN: "openbot-e2e-supervisor-token",
  WORKER_SHARED_SECRET: "openbot-e2e-worker-secret",
};

const SIGN_IN_SETTINGS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "MICROSOFT_OAUTH_CLIENT_ID",
  "MICROSOFT_OAUTH_CLIENT_SECRET",
  "OKTA_OAUTH_CLIENT_ID",
  "OKTA_OAUTH_CLIENT_SECRET",
  "OKTA_OAUTH_ISSUER",
  "OPENBOT_ORGANIZATION_AUTH_URL",
  "COMPUTER_SANDBOX_NAMESPACE",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "INITIAL_ADMIN_EMAILS",
];

export function stackEnvironment(): Record<string, string> {
  const app = APP_URL;
  return {
    ...(process.env as Record<string, string>),
    ...E2E_SECRETS,
    COMPOSE_PROJECT_NAME: COMPOSE_PROJECT,
    // start.sh writes the server, app and migration logs here instead of the checkout's .logs.
    OPENBOT_LOG_DIR: LOGS,
    // Image tags of its own: `openbot-agent-computer:latest` and the rest are shared by every
    // compose project on the machine, and `--build` would replace them under another stack.
    SERVER_IMAGE: "openbot-e2e-server:latest",
    COMPUTER_IMAGE: "openbot-e2e-agent-computer:latest",
    SUPERVISOR_IMAGE: "openbot-e2e-supervisor:latest",
    BOT_IMAGE: "openbot-e2e-agent-bot:latest",
    LANGGRAPH_IMAGE: "openbot-e2e-agent-langgraph:latest",

    APP_PORT: String(PORTS.app),
    SERVER_PORT: String(PORTS.server),
    PORT: String(PORTS.server),
    COMPUTER_PORT: String(PORTS.computer),
    BROWSER_PORT: String(PORTS.browser),
    BOT_PORT: String(PORTS.bot),
    LANGGRAPH_PORT: String(PORTS.langgraph),
    SUPERVISOR_PORT: String(PORTS.supervisor),
    POSTGRES_PORT: String(PORTS.postgres),
    DATABASE_URL: `postgres://openbot:openbot@127.0.0.1:${PORTS.postgres}/openbot`,
    AGENT_COMPUTER_URL: `http://127.0.0.1:${PORTS.computer}`,
    OPENBOT_APP_URL: app,
    OPENBOT_PUBLIC_URL: SERVER_URL,
    TRUSTED_ORIGINS: `${app},http://localhost:${PORTS.app}`,

    // The personal edition, as `.env.personal.example` and OpenBot Desktop set it.
    OPENBOT_EDITION: "personal",
    OPENBOT_SINGLE_USER: "true",
    TENANT_PACKAGE_DIR: "../examples/personal",
    OPENBOT_ONE_COMPUTER_EACH: "false",
    COMPUTER_SUPERVISOR_URL: "",
    COMPUTER_RUNTIME: "",
    AUDIT_RETENTION_DAYS: "90",
    // No Chrome window on the developer's desktop: the person's own browser is Teach a Bot's, which
    // a later slice drives. OpenBot Desktop runs without one too.
    OPENBOT_PERSON_BROWSER: "off",
    // Nobody signs in to the personal edition, and the server refuses to start with a sign-in
    // provider configured. A developer's `.env` is usually a team one, so these are blanked.
    ...Object.fromEntries(SIGN_IN_SETTINGS.map((name) => [name, ""])),
    // One app broker, Composio, as OpenBot Desktop sets up. With both keys in `.env` and no
    // OPENBOT_BROKER_PROVIDER the server refuses to start. (A blank COMPOSIO_API_KEY can't be used
    // to switch Composio off: start.sh unsets a blank one so the `.env` key wins.)
    ARCADE_API_KEY: "",
    // Composio's API is the stub's (`harness/composio-stub.ts`), so Browse apps, Add, Connect and
    // Disconnect run against a fixed catalogue and never reach a real account. `@composio/core` reads
    // COMPOSIO_BASE_URL when the server passes no base URL of its own, which it doesn't. A key that
    // isn't blank, so start.sh keeps it and never provisions a real Composio project for the run.
    COMPOSIO_BASE_URL: COMPOSIO_URL,
    COMPOSIO_API_KEY: DUMMY_COMPOSIO_KEY,
    // The MCP server a journey adds by its address is aimock's, on this machine's loopback over http,
    // which OpenBot refuses unless this is set (`server/src/plugins/catalogue.ts`). For tests only.
    OPENBOT_ALLOW_LOOPBACK_MCP: "1",

    // Every model provider OpenBot calls, pointed at aimock before the server builds a client.
    BOT_PROVIDER: "openai",
    OPENAI_BASE_URL: `${AIMOCK_URL}/v1`,
    // No OpenAI key: a new person has none, and the core loop adds one the way they do, in the
    // Vault. The key they add is `DUMMY_OPENAI_KEY`.
    OPENAI_API_KEY: "",
    ANTHROPIC_BASE_URL: AIMOCK_URL,
    ANTHROPIC_API_KEY: DUMMY_ANTHROPIC_KEY,
    GOOGLE_GENERATIVE_AI_BASE_URL: `${AIMOCK_URL}/v1beta`,
    GOOGLE_API_KEY: "",
    OPENAI_CONTAINER_BASE_URL: "",
    // The model list comes from aimock, which lists the models the fixtures name. Without capability
    // data from models.dev, OpenBot keeps the package's model (gpt-5.6-terra) rather than choosing
    // the "middle" of whatever aimock lists, which in record mode, before any fixture exists, is
    // aimock's default list. Also keeps the run off the network for something it does not test.
    OPENBOT_MODEL_CAPABILITIES_URL: "off",

    // Automatic Learning sends conversations to Intelligence, where its own models read them: model
    // traffic aimock cannot answer. Off for the run.
    OPENBOT_LEARNING_AUTO_ASSIGN: "false",
    // A test run is not product usage.
    DO_NOT_TRACK: "1",
    COPILOTKIT_TELEMETRY_DISABLED: "1",
  };
}

type Listener = { pid: number; cwd: string; command: string };

function listener(port: number): Listener | undefined {
  let pid: number;
  try {
    pid = Number(
      execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")[0],
    );
  } catch {
    return undefined;
  }
  if (!pid) return undefined;
  const cwd = execFileSync(
    "lsof",
    ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
    {
      encoding: "utf8",
    },
  )
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
  }).trim();
  return { pid, cwd: cwd ?? "", command };
}

/**
 * Stop what holds one of the run's own host ports, but only a process started from this checkout.
 * Docker's proxy (the compose services) is left to `docker compose down`.
 */
function stopOwnListener(port: number): void {
  const held = listener(port);
  if (!held) return;
  if (held.command.includes("com.docker") || held.command.includes("vpnkit"))
    return;
  if (!held.cwd.startsWith(ROOT)) {
    throw new Error(
      `Port ${port} is held by a process outside this checkout (pid ${held.pid}, ${held.cwd}). The end-to-end run uses ports 46xxx of its own; stop that process or free the port.`,
    );
  }
  process.kill(held.pid, "SIGTERM");
}

/** The host routine workers started from this checkout, by pid. */
function workersHere(): number[] {
  let pids: number[];
  try {
    pids = execFileSync("pgrep", ["-f", "bun worker/src/index.ts"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map(Number)
      .filter(Boolean);
  } catch {
    return [];
  }
  return pids.filter((pid) => {
    try {
      return execFileSync(
        "lsof",
        ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
        {
          encoding: "utf8",
        },
      ).includes(`n${ROOT}\n`);
    } catch {
      return false;
    }
  });
}

function compose(args: string[]): void {
  execFileSync("docker", ["compose", "-p", COMPOSE_PROJECT, ...args], {
    cwd: ROOT,
    env: stackEnvironment(),
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 300_000,
  });
}

async function waitUntilFree(port: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (listener(port) && Date.now() < deadline) {
    await new Promise((settle) => setTimeout(settle, 250));
  }
}

/** Stop the run's own stack, whatever state an earlier run left it in. */
export async function stopStack({
  volumes,
}: {
  volumes: boolean;
}): Promise<void> {
  for (const port of [PORTS.app, PORTS.server, PORTS.browser])
    stopOwnListener(port);
  let started: number[] = [];
  try {
    started = JSON.parse(readFileSync(STATE, "utf8")).workers ?? [];
  } catch {}
  for (const pid of started) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  compose(["down", "--remove-orphans", ...(volumes ? ["-v"] : [])]);
  await waitUntilFree(PORTS.app);
  await waitUntilFree(PORTS.server);
}

/** A fresh stack through `scripts/start.sh`, with its output in `e2e/.artifacts/logs/start.log`. */
export async function startStack(): Promise<void> {
  mkdirSync(LOGS, { recursive: true });
  await stopStack({ volumes: true });
  const before = new Set(workersHere());
  const log = openSync(START_LOG, "w");
  const code = await new Promise<number | null>((settle, fail) => {
    const child = spawn("bash", ["scripts/start.sh"], {
      cwd: ROOT,
      env: stackEnvironment(),
      stdio: ["ignore", log, log],
    });
    // The first run builds the server and computer images, which takes minutes.
    const deadline = setTimeout(() => child.kill("SIGTERM"), 20 * 60_000);
    child.on("error", fail);
    child.on("exit", (exit) => {
      clearTimeout(deadline);
      settle(exit);
    });
  });
  closeSync(log);
  const workers = workersHere().filter((pid) => !before.has(pid));
  writeFileSync(STATE, JSON.stringify({ workers }, null, 2));
  if (code !== 0) {
    throw new Error(
      `scripts/start.sh exited ${code}. Its output is in ${START_LOG}; the server's in ${SERVER_LOG}.`,
    );
  }
}
