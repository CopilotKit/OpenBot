import { spawn } from "node:child_process";

/**
 * Running a command on the Bot's computer.
 *
 * WHY THIS EXISTS. A browser answers questions about the web; a shell answers everything else. A Bot
 * that can install a tool and run it is a Bot that can do the task rather than describe it.
 *
 * WHAT MAKES IT SAFE IS NOT THIS FILE. Nothing here decides whether a command may run. The gateway
 * decides, against the deployment's policy, and writes the audit row before this is called at all,
 * the same as it does for a click. This file is the hands, not the judgement.
 *
 * WHAT THIS DOES DEFEND is the shape of the call rather than its content: a command cannot run
 * forever, cannot return unbounded output, runs in the workspace rather than wherever the process
 * happens to be, and does not inherit the computer's environment, so `env` cannot print the
 * deployment's secrets.
 *
 * ISOLATION IS THE CONTAINER'S JOB. A shell can reach whatever the container can reach, so the
 * deployment that gives a Bot one should give each Bot a computer of its own. In a container shared
 * between Bots, a shell is shared too.
 */

/** Long enough for an install, short enough that a hung command is not a hung Bot. */
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/**
 * How much output comes back.
 *
 * A build log is megabytes and the model that reads this has a context window. Truncated at a size
 * a person can still read, and the result says it was truncated rather than quietly ending.
 */
const MAX_OUTPUT_BYTES = 64 * 1024;

export type ShellResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  elapsedMs: number;
};

/**
 * The environment a command sees.
 *
 * WHY AN ALLOW LIST. The computer process holds the deployment's secrets when it runs inside the
 * one-container image. Spreading `process.env` into the child makes `env` print them. A deny list
 * is the secrets that existed on the day it was written; the next variable added to a deployment
 * is not on it.
 *
 * PATH, locale, terminal and the proxy variables pass because a command that cannot find `apt-get`,
 * cannot speak the operator's language, or cannot reach the network behind a corporate proxy is not
 * a shell. Everything else is named in COMPUTER_SHELL_ENV, read as names, so passing a secret is an
 * operator's decision rather than the default.
 *
 * HOME is the workspace. A command that writes to ~ should write where the Bot's files already are.
 */
const PATH_NAMES = ["PATH"] as const;
const LOCALE_NAMES = ["LANG", "LANGUAGE"] as const;
const TERMINAL_NAMES = ["TERM", "TERMINFO", "COLORTERM"] as const;
const PROXY_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "FTP_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "ftp_proxy",
] as const;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCALE_CATEGORY = /^LC_[A-Za-z0-9_]+$/;

export function environmentForCommand(
  source: NodeJS.ProcessEnv,
  workspaceDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};

  const copy = (name: string) => {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  };

  for (const name of PATH_NAMES) copy(name);
  for (const name of LOCALE_NAMES) copy(name);
  for (const name of Object.keys(source)) {
    if (LOCALE_CATEGORY.test(name)) copy(name);
  }
  for (const name of TERMINAL_NAMES) copy(name);
  for (const name of PROXY_NAMES) copy(name);
  for (const name of extraShellEnvNames(source.COMPUTER_SHELL_ENV)) copy(name);

  env.HOME = workspaceDir;
  /*
   * Set rather than copied, because the deployment has no opinion about it and the command does. The
   * tool description tells the model to run `apt-get install`, which without this waits for an answer
   * to a prompt nobody is there to give: the command reaches its timeout and comes back looking like
   * a broken package rather than a question. An operator can still override it through
   * COMPUTER_SHELL_ENV, which is copied above.
   */
  if (env.DEBIAN_FRONTEND === undefined) env.DEBIAN_FRONTEND = "noninteractive";
  return env;
}

function extraShellEnvNames(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => ENV_NAME.test(name));
}

function clamp(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) {
    return { text, truncated: false };
  }
  // Kept from the end. A command that fails says why in its last lines, and the first 64KB of a
  // build log is the part nobody needs.
  const kept = Buffer.from(text, "utf8")
    .subarray(-MAX_OUTPUT_BYTES)
    .toString("utf8");
  return { text: kept, truncated: true };
}

export function createShell(
  workspaceDir: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
) {
  return {
    async run(input: {
      command: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    }): Promise<ShellResult> {
      const started = Date.now();
      const timeoutMs = Math.min(
        input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      );

      /*
       * Through a shell on purpose. A Bot writes `apt-get install -y jq && jq --version`, and pipes,
       * redirection and `&&` are most of why a shell is useful. Refusing them would leave something
       * that runs one binary and calls itself a shell.
       *
       * This is the argument for the container boundary rather than for string parsing: there is no
       * safe way to read a command's intent from its text, so nothing here tries. The policy decides
       * whether this Bot may run commands at all and what they may say; the container decides what a
       * command can reach.
       */
      const child = spawn("/bin/bash", ["-lc", input.command], {
        cwd: workspaceDir,
        env: environmentForCommand(sourceEnv, workspaceDir),
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      // The person's Stop reaches the command, not just the request that started it.
      const onAbort = () => child.kill("SIGKILL");
      input.signal?.addEventListener("abort", onAbort, { once: true });

      const exitCode = await new Promise<number>((resolve) => {
        child.on("close", (code) => resolve(code ?? -1));
        child.on("error", () => resolve(-1));
      });

      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);

      const out = clamp(stdout);
      const err = clamp(stderr);
      return {
        command: input.command,
        exitCode,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        timedOut,
        elapsedMs: Date.now() - started,
      };
    },
  };
}

export type Shell = ReturnType<typeof createShell>;
