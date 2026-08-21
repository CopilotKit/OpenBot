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
 * forever, cannot return unbounded output, and runs in the workspace rather than wherever the
 * process happens to be.
 *
 * ISOLATION IS THE CONTAINER'S JOB. A shell can reach whatever the container can reach, so the
 * deployment that gives a Bot one should give each Bot a computer of its own. In a container shared
 * between Bots, a shell is shared too.
 */

/**
 * The environment a Bot's command is allowed to see.
 *
 * An allow-list rather than a deny-list, because the interesting names are the ones nobody thought
 * of. This process is started with the container's whole environment on purpose: it needs
 * `COMPUTER_TOKEN` to authenticate its own callers. In the one-container image that environment also
 * carries `DATABASE_URL`, `KEY_ENCRYPTION_KEY`, the licence and the model key, because there is one
 * environment and every service reads it.
 *
 * Handing that to a command a Bot wrote would undo the gateway. `COMPUTER_TOKEN` is the only thing in
 * front of the control surface on port 4100, and this shell runs inside the process that serves it,
 * so a Bot holding the token could drive the browser over loopback with no policy decision and no
 * audit row. The rest is worse in a quieter way: the database URL and the encryption key together
 * open the credential vault and the trail that is supposed to record what happened.
 *
 * What is left is what a command needs to run at all. Without `PATH` nothing resolves, and the tool
 * description tells the model to install packages, which needs one.
 */
const INHERITED = ["PATH", "TERM", "LANG", "LC_ALL", "TZ"] as const;

function commandEnvironment(workspaceDir: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    // The workspace, so a relative path means the same thing here as it does to the file tools.
    HOME: workspaceDir,
    // Fallback for a container that sets no PATH of its own; an inherited one overwrites it below.
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    // `apt-get install` without this waits for an answer nobody is there to give, and the command
    // times out looking like a broken package rather than a prompt.
    DEBIAN_FRONTEND: "noninteractive",
  };
  for (const name of INHERITED) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

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
        // Not `process.env`. See INHERITED above: this process holds the deployment's secrets and a
        // command a Bot wrote is the last thing that should be able to read them.
        env: commandEnvironment(workspaceDir),
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
