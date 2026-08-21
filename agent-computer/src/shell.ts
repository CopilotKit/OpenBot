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
 * happens to be, and sees the environment a command needs rather than the one the deployment runs
 * on.
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

/**
 * What a command sees of the deployment it runs in.
 *
 * A child process inherits its parent's environment, and this parent is the computer. In the
 * one-container image that process sits beside the API and `docker/s6/s6-rc.d/computer/run` hands it
 * the container's environment deliberately, so what a command would inherit is everything the API
 * was given: the key that decrypts stored credentials, the database URL, the model key. `env` is a
 * command like any other, and the trail records that a command ran without recording what it
 * returned, so reading all of them is one call that leaves an unremarkable row.
 *
 * AN ALLOW LIST RATHER THAN A DENY LIST. A deny list is the secrets that existed on the day it was
 * written. The next variable somebody adds to a deployment is not on it, and a boundary that stops
 * holding without saying so is the failure this repository has already taken two features back for.
 *
 * What stays is what a command needs to run at all, plus the proxy variables, because a deployment
 * behind a proxy has an `apt-get` that reaches nothing without them.
 *
 * THIS IS A FLOOR, NOT THE BOUNDARY. `sudo` is passwordless in the image, and root in a shared
 * container can read another process's environment whatever this function returns. What it removes
 * is the one-word version.
 */
const ALWAYS_PASSED = [
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "TERM",
  "TZ",
  "USER",
  "LOGNAME",
  "HOSTNAME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

/**
 * The environment for one command.
 *
 * `COMPUTER_SHELL_ENV` names anything else a deployment wants a command to see, comma separated. It
 * is an opt-in and it is read literally: an operator who names a secret there has said to pass that
 * secret, which is a different thing from a shell that takes everything by default.
 */
export function commandEnvironment(
  env: Record<string, string | undefined>,
  workspaceDir: string,
): Record<string, string> {
  const named = (env.COMPUTER_SHELL_ENV ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  const passed: Record<string, string> = {};
  for (const name of [...ALWAYS_PASSED, ...named]) {
    const value = env[name];
    if (value !== undefined) passed[name] = value;
  }

  // Last, so that neither list can point a command's home somewhere other than its workspace.
  passed.HOME = workspaceDir;
  return passed;
}

export type ShellResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  elapsedMs: number;
};

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

export function createShell(workspaceDir: string) {
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
        env: commandEnvironment(process.env, workspaceDir),
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
