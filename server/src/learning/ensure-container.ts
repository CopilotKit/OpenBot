/**
 * Create a Learning container in the runtime key's own project.
 *
 * Intelligence 0.16.0 and later create one for a project key on `POST /api/v1/learning/containers`,
 * idempotent by id, so the key the server already holds is all this needs: for the project's
 * `openbot` default (learning/auto-assign.ts, at boot and from Admin → Automatic Learning) and for
 * each person's own Learning space (learning/personal-space.ts). The body names no project, so the
 * key cannot make one anywhere but its own.
 *
 * An older Intelligence has no such route. OpenBot needs 0.16.0, and on anything older the log and
 * Admin say to create the container by hand or upgrade.
 *
 * This file also holds the CopilotKit CLI helpers the setup scripts share (`runCli` and friends).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { transientStatus } from "../intelligence-startup";
import {
  type ContainerProbe,
  probeLearningContainer,
  runtimeKeyClient,
} from "./auto-assign";

export const MANAGED_API = "https://api.intelligence.copilotkit.ai";

/** A Learning container to create: its id (Intelligence's 1 to 64 lowercase letters, digits and single hyphens) and name. */
export type LearningContainerSpec = { id: string; name: string };
/** The project's shared default, which Automatic Learning assigns. */
export const OPENBOT_CONTAINER: LearningContainerSpec = {
  id: "openbot",
  name: "OpenBot",
};

/** `created`: made just now. `present`: it was already there under that id. */
export type ContainerCreation = "created" | "present";

/** What the configured runtime key can answer about its own project, and do in it. */
export type KeyIntelligence = {
  probe: (containerId: string) => Promise<ContainerProbe>;
  create: (container: LearningContainerSpec) => Promise<ContainerCreation>;
};

export function keyIntelligence(
  apiUrl: string,
  apiKey: string,
  wsUrl?: string,
  fetchImpl: typeof fetch = fetch,
): KeyIntelligence {
  const client = runtimeKeyClient(apiUrl, apiKey, wsUrl);
  return {
    probe: (containerId) => probeLearningContainer(client, containerId),
    create: (container) =>
      createWithRuntimeKey({ apiUrl, apiKey, fetch: fetchImpl, container }),
  };
}

/**
 * Create a container with the runtime key, in the project Intelligence reads off that key.
 *
 * 201 is a new container and 200 the one already stored under that id, unchanged, so replicas and
 * people racing to ensure the same container all end with it. A 409 from an Intelligence that
 * reports a taken id instead is present too. 404 is an Intelligence older than 0.16.0, or one with
 * Learning switched off. A failure that may pass in a moment (nothing answering, a 5xx, a 408 or
 * 429) is thrown marked `retryable`, which the server's automatic assignment reads as Intelligence
 * still starting rather than as its one try.
 */
export async function createWithRuntimeKey(input: {
  apiUrl: string;
  apiKey: string;
  fetch: typeof fetch;
  container: LearningContainerSpec;
}): Promise<ContainerCreation> {
  const { container } = input;
  let response: Response;
  try {
    response = await input.fetch(
      `${input.apiUrl.replace(/\/+$/, "")}/api/v1/learning/containers`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ id: container.id, name: container.name }),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (error) {
    throw Object.assign(
      new Error(
        `Intelligence did not answer the runtime key's request to create the ${container.id} Learning container (${error instanceof Error ? error.message : String(error)}).`,
      ),
      { retryable: true },
    );
  }
  const body: unknown = await response.json().catch(() => null);
  const code =
    object(body) && object(body.error) && typeof body.error.code === "string"
      ? body.error.code
      : undefined;
  if (response.status === 201 || response.status === 200) {
    if (
      object(body) &&
      object(body.container) &&
      body.container.id === container.id
    )
      return response.status === 201 ? "created" : "present";
    throw new Error(
      `Intelligence answered the runtime key's container request with something other than the ${container.id} container. Nothing was assigned.`,
    );
  }
  if (response.status === 409 && code === "LEARNING_CONTAINER_ALREADY_EXISTS")
    return "present";
  if (response.status === 404)
    throw new Error(
      `This Intelligence cannot create Learning containers for a runtime key: it is older than 0.16.0, or Learning is switched off. ${learningSetupInstructions(container.id)}`,
    );
  if (code === "LEARNING_NOT_ENABLED")
    throw new Error(
      "This Intelligence's licence does not include Learning, so no container was created.",
    );
  throw Object.assign(
    new Error(
      `Intelligence could not create the ${container.id} Learning container with the runtime key (HTTP ${response.status}${code ? `, ${code}` : ""}). OpenBot tries again.`,
    ),
    { retryable: transientStatus(response.status) },
  );
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function json(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (object(value)) return value;
  } catch {}
  throw new Error(
    "CopilotKit returned an invalid setup response. No Learning assignment was saved.",
  );
}

/**
 * What an operator does when the container could not be created here. One sentence set, shared by
 * the server log, Admin → Automatic Learning and `scripts/setup-learning.ts`, so all three say the same.
 */
export function learningSetupInstructions(
  containerId: string = OPENBOT_CONTAINER.id,
): string {
  return `Upgrade Intelligence to 0.16.0 or later, where OpenBot creates it with its runtime key, or create a Learning container with ID "${containerId}" in this project in Intelligence. OpenBot assigns it within ten minutes either way.`;
}

/** Create `container` in the runtime key's project: `created`, or `present` when that id was already taken there. */
export function createLearningContainer(input: {
  key: KeyIntelligence;
  container?: LearningContainerSpec;
}): Promise<ContainerCreation> {
  return input.key.create(input.container ?? OPENBOT_CONTAINER);
}

/**
 * Make sure the runtime key's project has `openbot`, creating it when it is missing. Never writes
 * `.env` and never replaces the key: the server assigns the container once it exists
 * (learning/auto-assign.ts).
 */
export async function ensureLearningContainer(input: {
  key: KeyIntelligence;
}): Promise<ContainerCreation> {
  const found = await input.key.probe(OPENBOT_CONTAINER.id);
  if (found === "present") return "present";
  if (found === "not_entitled") {
    throw new Error(
      "This Intelligence project's plan does not include Learning. Nothing was created.",
    );
  }
  if (found === "learning_off") {
    throw new Error(
      "Learning is switched off in this Intelligence (learning.enabled in its Helm chart). Turn it on there, then run this again. Nothing was created.",
    );
  }
  if (found === "unavailable") {
    // Retryable: the server gets here only after its own probe answered, so Intelligence is starting or flapping.
    throw Object.assign(
      new Error(
        "Intelligence could not be asked about the openbot Learning container with the configured runtime key. Check INTELLIGENCE_API_URL and INTELLIGENCE_API_KEY, then try again.",
      ),
      { retryable: true },
    );
  }
  return createLearningContainer(input);
}

export type CliResult = { exitCode: number; stdout: string };
export type RunCli = (args: string[], directory: string) => Promise<CliResult>;

/**
 * The environment the CLI runs with: where it finds its login and how it reaches npm, and nothing
 * else. It is `copilotkit@latest` from the registry, so it never sees this process's secrets.
 */
const CLI_ENVIRONMENT =
  /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TEMP|TMP|LANG|LC_[A-Z]+|XDG_[A-Z_]+|APPDATA|LOCALAPPDATA|USERPROFILE|SYSTEMROOT|SystemRoot|COMSPEC|PATHEXT|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|NODE_EXTRA_CA_CERTS|npm_config_[a-z_]+|NPM_CONFIG_[A-Z_]+|COPILOTKIT_CONFIG_DIR|COPILOTKIT_DEPLOYMENT|COPILOTKIT_APP_API_URL|COPILOTKIT_OPS_API_URL|COPILOTKIT_TELEMETRY_DISABLED)$/;

export function cliEnvironment(
  environment: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const kept: Record<string, string> = { COPILOTKIT_TELEMETRY_DISABLED: "1" };
  for (const [name, value] of Object.entries(environment))
    if (value !== undefined && CLI_ENVIRONMENT.test(name)) kept[name] = value;
  return kept;
}

/**
 * How to start `npx` on a platform. Windows ships it as `npx.cmd`, and since CVE-2024-27980 Node and
 * Bun refuse to spawn a `.cmd` without a shell: `spawn` throws EINVAL before anything runs.
 */
export function npxCommand(platform: NodeJS.Platform = process.platform): {
  command: string;
  shell: boolean;
} {
  return platform === "win32"
    ? { command: "npx.cmd", shell: true }
    : { command: "npx", shell: false };
}

/**
 * Whether every argument reaches the program as written through `cmd.exe`. The shell joins them into
 * one unquoted command line, so `&` or `|` in one would start another command and `%` would expand a
 * variable. Not every argument is a literal: `setup-learning.ts` passes the project id it reads from
 * `.copilotkit/project.json`.
 */
export function cmdLineSafe(args: string[]): boolean {
  return args.every((arg) => /^[A-Za-z0-9@._:/+-]+$/.test(arg));
}

/**
 * `child.kill()` on Windows ends `cmd.exe` and leaves the command under it running, holding the
 * pipes, so `close` waits for that command however long it takes. `taskkill /T` ends the tree.
 * Once `cmd.exe` has exited its id may belong to another process, so it is not used after that.
 */
export function stopProcessTree(child: ChildProcess, shell: boolean): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!shell || child.pid === undefined) {
    child.kill();
    return;
  }
  // By full path: a bare name is looked up in the working directory first.
  const taskkill = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "taskkill.exe",
  );
  spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
  })
    .on("error", () => child.kill())
    .on("exit", (code) => {
      if (code !== 0) child.kill();
    });
}

/** Run `npx <args>` in `directory`, for at most two minutes. */
export const runNpx = (args: string[], directory: string): Promise<CliResult> =>
  new Promise((resolvePromise) => {
    const { command, shell } = npxCommand();
    if (shell && !cmdLineSafe(args)) {
      resolvePromise({ exitCode: 1, stdout: "" });
      return;
    }
    const child = spawn(command, args, {
      cwd: directory,
      env: cliEnvironment(),
      shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 1_048_576) stdout += chunk;
    });
    // CLI output on stderr can carry account or credential details. Never relay it.
    child.stderr.resume();
    const timeout = setTimeout(() => stopProcessTree(child, shell), 120_000);
    const finish = (exitCode: number) => {
      clearTimeout(timeout);
      resolvePromise({ exitCode, stdout });
    };
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
  });

/** Run `npx --yes copilotkit@latest <args>` in `directory`, for at most two minutes. */
export const runCli: RunCli = (args, directory) =>
  runNpx(["--yes", "copilotkit@latest", ...args], directory);
