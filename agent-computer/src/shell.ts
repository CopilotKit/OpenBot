import { egressShellEnvironment, splitProxyCredentials } from "./egress";
import { createLiveShell } from "./live-shell";
import { readableOutput } from "./shell-marks";

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
  /** Never typed: the shell was busy with something a person started. */
  notRun?: boolean;
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
  const { server, username, password } = splitProxyCredentials(raw);
  if (username === undefined && password === undefined) return raw;
  return server;
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
  options: { bash?: string } = {},
) {
  /*
   * One live shell for this Bot, which its commands are typed into and a person can watch and take
   * over (live-shell.ts). It used to be a fresh `bash -c` for each command.
   *
   * The shell is interactive now, and still never reads a startup file from the workspace: it starts
   * with one the computer writes elsewhere, because HOME is the workspace and a Bot writes files
   * there. A `.bash_profile` or `.bashrc` it left behind would otherwise run before every later
   * command while the audit row recorded only what was asked for. The allow-list above means such a
   * file can no longer recover a secret, but it could still change what a command does.
   *
   * The environment is built when a shell starts, with the egress filter's address last, so a command
   * cannot be pointed around it.
   */
  const live = createLiveShell({
    cwd: workspaceDir,
    env: () => ({
      ...environmentForCommand(sourceEnv, workspaceDir),
      ...egressShellEnvironment(),
    }),
    ...(options.bash ? { bash: options.bash } : {}),
  });

  return {
    async run(input: {
      command: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    }): Promise<ShellResult> {
      const started = Date.now();
      /*
       * Bounded at both ends. Only `Math.min` was applied, so a zero or negative `timeoutMs` from a
       * caller made the timer fire immediately: the command was killed before it did anything and
       * the answer said it had timed out, which is true and useless.
       *
       * A non-finite value is the same failure one step earlier: `Math.max(NaN, 1000)` is `NaN`.
       * The HTTP layer rejects those with a 400, so this is defence in depth for a direct caller —
       * fall back to the default rather than run a command that is already out of time.
       */
      const requested =
        typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
          ? input.timeoutMs
          : DEFAULT_TIMEOUT_MS;
      const timeoutMs = Math.min(
        Math.max(requested, MIN_TIMEOUT_MS),
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
       *
       * The deadline starts now, not when the command is typed: a command waiting behind another of
       * the Bot's own is still inside the time it was given.
       *
       * The person's Stop reaches the command too: the shell presses Ctrl-C for it, then stops its
       * process group, then the shell, so nothing the command started outlives it.
       */
      const outcome = await live.run({
        command: input.command,
        deadline: started + timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      });

      /*
       * One stream, because a terminal has one: stdout and stderr arrive interleaved, as a person
       * watching sees them, so they come back as `stdout`.
       */
      const text = outcome.busy
        ? ""
        : readableOutput(outcome.raw) +
          (outcome.incomplete ? INCOMPLETE_COMMAND : "");
      const out = clamp(text);
      return {
        command: input.command,
        exitCode: outcome.exitCode,
        stdout: out.text,
        stderr: outcome.busy ? SHELL_BUSY : "",
        // Either point it was cut: while arriving, or on the way out.
        truncated: out.truncated || outcome.dropped,
        timedOut: outcome.timedOut,
        elapsedMs: Date.now() - started,
        ...(outcome.busy ? { notRun: true } : {}),
      };
    },
    /** What a person watching or driving the shell reaches. See live-shell.ts. */
    terminal: live,
    /** End this shell for good. */
    dispose: () => live.dispose(),
  };
}

/** Said when the shell was left waiting for the rest of a command the Bot sent. */
const INCOMPLETE_COMMAND =
  "\nbash: the command was incomplete (an unclosed quote, bracket or here-document), so it did not run.\n";

/** Said when a person left something running in the shell's foreground and handed it back. */
const SHELL_BUSY =
  "The command was not run: the shell is still running something a person started. Ask them to finish it.";

export type Shell = ReturnType<typeof createShell>;
