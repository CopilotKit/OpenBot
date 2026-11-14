import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";

/**
 * Running the CopilotKit CLI (`npx --yes copilotkit@latest`) from this checkout, for the setup
 * helpers beside this file: Composio provisioning, Learning setup and the local Intelligence CLI.
 */

export type CliResult = { exitCode: number; stdout: string };
export type RunCli = (args: string[], directory: string) => Promise<CliResult>;

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
