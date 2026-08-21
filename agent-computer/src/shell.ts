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
/** A command has to be given long enough to start. Below this, a caller is asking for nothing. */
const MIN_TIMEOUT_MS = 1_000;
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
 * a shell. Proxy URLs routinely carry a password; userinfo is stripped before the value is copied, so
 * `env` cannot print it. Naming the credentialed URL in COMPUTER_SHELL_ENV is an operator's decision
 * rather than the default. Everything else is named there too, read as names.
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

  const copyProxy = (name: string) => {
    const value = source[name];
    if (value !== undefined) env[name] = withoutUserinfo(value);
  };

  for (const name of PATH_NAMES) copy(name);
  for (const name of LOCALE_NAMES) copy(name);
  for (const name of Object.keys(source)) {
    if (LOCALE_CATEGORY.test(name)) copy(name);
  }
  for (const name of TERMINAL_NAMES) copy(name);
  for (const name of PROXY_NAMES) copyProxy(name);
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

/**
 * Names COMPUTER_SHELL_ENV will not pass, whatever an operator writes.
 *
 * The rest of that setting is a decision an operator is entitled to make: naming `GITHUB_TOKEN` says
 * this Bot may use that token, and they meant it. These are different in kind. They do not give a
 * command information, they give it a hook that runs before every later command, which is the
 * `.bash_profile` hole arriving through the front door.
 *
 * `BASH_ENV` is the one that survives `-c`: bash expands it for a non-interactive shell and sources
 * the file it names, before the command. `ENV` is its POSIX-mode twin, `BASH_XTRACEFD` writes where
 * it is told, `LD_PRELOAD` and `LD_LIBRARY_PATH` are the same idea one layer down, and the option
 * variables change how the shell parses what follows.
 *
 * Refused rather than dropped quietly, because an operator who wrote one of these has a reason in
 * mind and deserves to be told it did not happen.
 */
const NEVER_PASSED = new Set([
  "BASH_ENV",
  "ENV",
  "BASH_XTRACEFD",
  "BASHOPTS",
  "SHELLOPTS",
  "CDPATH",
  "GLOBIGNORE",
  "IFS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "PS4",
]);

function extraShellEnvNames(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const named = raw.split(",").map((name) => name.trim());

  /*
   * A name that is not a name, and a name that is refused, are both worth saying out loud. Silently
   * skipping either leaves an operator with a command that fails somewhere else for a reason that
   * never mentions what they wrote.
   */
  for (const name of named) {
    if (name === "") continue;
    if (!ENV_NAME.test(name)) {
      console.warn(
        JSON.stringify({
          type: "computer-shell-env-ignored",
          name,
          reason: "not a variable name",
        }),
      );
      continue;
    }
    if (NEVER_PASSED.has(name)) {
      console.warn(
        JSON.stringify({
          type: "computer-shell-env-refused",
          name,
          reason:
            "runs before every command rather than informing one, so it is never passed",
        }),
      );
    }
  }

  return named.filter((name) => ENV_NAME.test(name) && !NEVER_PASSED.has(name));
}

/**
 * Credentials commonly arrive inside a proxy URL. They are stripped so the shell can still reach
 * the network without `env` printing a password. Same split `egress.ts` uses for the browser proxy.
 */
function withoutUserinfo(raw: string): string {
  try {
    const url = new URL(raw.trim());
    if (url.username === "" && url.password === "") return raw;
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch (e) {
    if (e instanceof TypeError) return raw;
    throw e;
  }
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
      /*
       * Bounded at both ends. Only `Math.min` was applied, so a zero or negative `timeoutMs` from a
       * caller made `setTimeout` fire immediately: the command was killed before it did anything and
       * the answer said it had timed out, which is true and useless.
       */
      const timeoutMs = Math.min(
        Math.max(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
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
      /*
       * `-c`, not `-lc`. A login shell sources `$HOME/.bash_profile`, and HOME is the workspace a Bot
       * writes with `computer_write_file`. That let a Bot leave a file which every later command ran
       * first: it could put its own `apt-get` earlier on PATH, and the audit row would still read
       * `apt-get --version`. The allow-list above means such a file can no longer recover a secret,
       * but it could still change what a command does. A permissive shell is a decision a deployment
       * can make. A trail that describes something other than what ran is not.
       */
      /*
       * Its own process group, so stopping it stops what it started.
       *
       * `child.kill` signals bash alone. `bash -c "sleep 600 | cat"` leaves the sleep and the cat
       * holding the inherited pipes, so `close` never fires and the await never settles: the command
       * runs on and the caller waits for the transport to give up instead. Killing the negative pid
       * signals the whole group.
       */
      const child = spawn("/bin/bash", ["-c", input.command], {
        cwd: workspaceDir,
        env: environmentForCommand(sourceEnv, workspaceDir),
        detached: true,
      });

      let timedOut = false;

      /*
       * Trimmed while it arrives, not at the end.
       *
       * `clamp` ran after `close`, so the string grew without limit until then. `cat` of a large file
       * or `base64 /dev/urandom` allocated until the process died, and that process owns the browser
       * every Bot on this computer is using.
       *
       * Trimming here has to carry the fact that it happened. Clamping at the end could tell, by
       * looking at the size; a stream that was already trimmed arrives under the limit and looks
       * complete. Losing the flag would be worse than the allocation: output that quietly ends is
       * output a model reads as the whole answer.
       */
      const collect = () => {
        let text = "";
        let dropped = false;
        return {
          add(chunk: unknown) {
            text += String(chunk);
            if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES * 2) return;
            text = Buffer.from(text, "utf8")
              .subarray(-MAX_OUTPUT_BYTES)
              .toString("utf8");
            dropped = true;
          },
          get text() {
            return text;
          },
          get dropped() {
            return dropped;
          },
        };
      };

      const outBuffer = collect();
      const errBuffer = collect();

      child.stdout.on("data", (chunk) => {
        outBuffer.add(chunk);
      });
      child.stderr.on("data", (chunk) => {
        errBuffer.add(chunk);
      });

      const stop = () => {
        const { pid } = child;
        if (pid === undefined) return;
        try {
          // The group, so nothing the command backgrounded outlives it.
          process.kill(-pid, "SIGKILL");
        } catch {
          // Already gone, or the group went with it. Either way there is nothing left to stop.
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);

      // The person's Stop reaches the command, not just the request that started it.
      const onAbort = stop;
      input.signal?.addEventListener("abort", onAbort, { once: true });

      const exitCode = await new Promise<number>((resolve) => {
        child.on("close", (code) => resolve(code ?? -1));
        child.on("error", () => resolve(-1));
      });

      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);

      const out = clamp(outBuffer.text);
      const err = clamp(errBuffer.text);
      return {
        command: input.command,
        exitCode,
        stdout: out.text,
        stderr: err.text,
        // Either end of the pipe, and either point it was cut: while arriving, or on the way out.
        truncated:
          out.truncated ||
          err.truncated ||
          outBuffer.dropped ||
          errBuffer.dropped,
        timedOut,
        elapsedMs: Date.now() - started,
      };
    },
  };
}

export type Shell = ReturnType<typeof createShell>;
