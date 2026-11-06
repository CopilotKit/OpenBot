import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as ScreenModel } from "@xterm/headless";
import {
  CONTINUED,
  createMarkScanner,
  MARK_OSC,
  type ShellMark,
  STARTED,
} from "./shell-marks";

/**
 * The Bot's live shell: one bash in a pseudo-terminal for each Bot's computer.
 *
 * WHY ONE. A command used to be a throwaway `bash -c`, and its output was text on a web page. A
 * person could neither watch it as a terminal nor take the keyboard. Here the Bot's commands are
 * typed into one shell that stays up, so whoever watches sees each command typed and its output as
 * it streams, `cd` and the environment carry over from one command to the next, and a person holding
 * the wheel types into the same shell the Bot carries on in once they hand it back.
 *
 * THE BOT STILL GETS AN ANSWER. Each command's output and real exit code come back as before, with
 * the same limits on time and size. The shell marks where each command starts and ends with escape
 * sequences only the computer can predict (shell-marks.ts).
 *
 * WHAT IT IS NOT. Nothing here decides whether a command may run or who may type. The gateway judges
 * the Bot's commands, and the computer's wheel (control.ts) decides who holds the keyboard. This file
 * is the hands.
 *
 * WHO WATCHES. Any number of viewers, each sent the screen as it is now (rebuilt from a headless
 * xterm.js with its serialize add-on, the way xterm.js recommends restoring a terminal on reconnect)
 * and then the live bytes. A viewer that falls behind is not allowed to slow the shell down: it stops
 * being sent bytes, and once it has caught up it is sent the screen again.
 */

/** Columns and rows before any viewer has said how big its terminal is. */
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
/** The range a viewer may resize to. Outside it is a broken client, not a terminal. */
const MIN_COLS = 20;
const MAX_COLS = 400;
const MIN_ROWS = 5;
const MAX_ROWS = 200;

/** Lines of history a viewer who arrives late is sent. */
const SCROLLBACK_LINES = 2_000;

/**
 * Flow control for viewers, after xterm.js's own guide: a viewer acknowledges what it has drawn, and
 * past the high mark it is sent nothing until it is back under the low one. Then it is sent the
 * screen as it is, which costs less than every byte it missed and ends in the same place.
 */
export const VIEWER_HIGH_WATER = 512 * 1024;
export const VIEWER_LOW_WATER = 64 * 1024;

/** How long a shell may take to show its first prompt before starting it is called a failure. */
const START_TIMEOUT_MS = 15_000;
/** How long the Bot waits for a shell a person was using to come back to its prompt. */
const PROMPT_GRACE_MS = 750;
/** Between asking a command to stop and making it. */
const INTERRUPT_GRACE_MS = 2_000;
/** A shell nobody is watching or using is stopped after this, and starts again when it is next needed. */
const IDLE_MS = 60 * 60 * 1000;
/** A command's output kept while it arrives, trimmed from the start past twice this. */
const MAX_KEPT_OUTPUT = 64 * 1024;
const MAX_HELD_OUTPUT = MAX_KEPT_OUTPUT * 2;

/** What the terminal says when its shell ends. A person watching reads these. */
const SHELL_ENDED = "The shell ended. A new one starts when it's next used.";
const COMMAND_WOULD_NOT_STOP =
  "The command didn't stop, so the shell ended. A new one starts when it's next used.";

/** What a command's run reports, before the shell module shapes it for the HTTP answer. */
export type CommandOutcome = {
  /** What the command printed, as raw terminal text. */
  raw: string;
  /** Text was dropped from the start while it arrived, so `raw` is the end of it. */
  dropped: boolean;
  exitCode: number;
  timedOut: boolean;
  stopped: boolean;
  /** The command was never typed: the shell was busy with something a person started. */
  busy: boolean;
  /** The shell was still waiting for the rest of the command, so it was abandoned. */
  incomplete: boolean;
};

/** Where a viewer's bytes go. Binary is terminal output; text is a JSON message. */
export type ViewerSink = {
  binary(bytes: Uint8Array): void;
  text(message: Record<string, unknown>): void;
};

export type ViewerHandle = {
  /** The viewer has drawn this many more bytes. */
  ack(bytes: number): void;
  detach(): void;
};

type Viewer = {
  sink: ViewerSink;
  /** Waiting for its first screen. Bytes that arrive meanwhile are kept to follow it. */
  syncing: boolean;
  pending: Uint8Array[];
  pendingBytes: number;
  /** Sent and not yet acknowledged. */
  unacked: number;
  /** Past the high mark: sent nothing until it is back under the low one. */
  behind: boolean;
};

type Run = {
  nonce: string;
  phase: "echo" | "output";
  out: string;
  dropped: boolean;
  incomplete: boolean;
  timedOut: boolean;
  stopped: boolean;
  finish: (status: number) => void;
};

type Running = {
  process: Bun.Subprocess;
  terminal: Bun.Terminal;
  directory: string;
  turnFile: string;
  startedAt: number;
  /** Resolves once the shell has drawn its first prompt. */
  ready: Promise<void>;
};

export type LiveShellOptions = {
  /** Where the shell starts. The Bot's workspace. */
  cwd: string;
  /** The environment it starts with, asked each time a shell starts. */
  env: () => Record<string, string>;
  /** The bash to run. Found on PATH when absent; see `findBash`. */
  bash?: string;
};

/**
 * A bash new enough for the marks: `PS0` arrived in 4.4. The image's is 5.2. A Mac's own
 * `/bin/bash` is 3.2, so on a developer's machine this finds a newer one on PATH.
 */
let foundBash: string | undefined;
export function findBash(): string {
  if (foundBash) return foundBash;
  const candidates = ["/bin/bash", Bun.which("bash")].filter(
    (path): path is string => typeof path === "string",
  );
  for (const candidate of candidates) {
    const probe = Bun.spawnSync([
      candidate,
      "-c",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bash expands this, not JavaScript.
      'echo "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"',
    ]);
    const [major, minor] = probe.stdout
      .toString()
      .trim()
      .split(" ")
      .map(Number);
    if (
      probe.exitCode === 0 &&
      major !== undefined &&
      minor !== undefined &&
      (major > 4 || (major === 4 && minor >= 4))
    ) {
      foundBash = candidate;
      return candidate;
    }
  }
  throw new Error(
    "The computer's shell needs bash 4.4 or newer, and none was found.",
  );
}

/**
 * The shell's own startup file, written outside the workspace.
 *
 * Not the workspace's `.bashrc` or `.bash_profile`: HOME is the workspace, a Bot writes files there,
 * and a startup file it wrote would run before every later command while the audit trail recorded only
 * what was asked for. `INPUTRC` points at a file next to this one for the same reason, since readline
 * reads `~/.inputrc` and that can rebind Enter.
 *
 * The marks' variables are read-only, so neither the Bot nor a person can switch them off by accident
 * and leave every later command waiting for an end that never comes. PS1 stays theirs.
 */
function startupFile(turnFile: string): string {
  return `# The Bot's live shell. Written by the computer; see agent-computer/src/live-shell.ts.
set +o histexpand
unset HISTFILE MAILCHECK MAILPATH
HISTSIZE=2000
shopt -s checkwinsize
stty -ixon 2>/dev/null
__openbot_prompt() {
  local status=$?
  local turn=
  IFS= read -r turn < '${turnFile}' 2>/dev/null
  printf '\\033]${MARK_OSC};D;%s;%s\\007' "$turn" "$status"
}
PROMPT_COMMAND=__openbot_prompt
PS0='${STARTED.replace("\x1b", "\\033").replace("\x07", "\\007")}'
PS1='\\[\\033[38;5;147m\\]\\w\\[\\033[0m\\] \\$ '
PS2='\\[${CONTINUED.replace("\x1b", "\\033").replace("\x07", "\\007")}\\]> '
readonly PROMPT_COMMAND PS0 PS2
readonly -f __openbot_prompt
`;
}

const INPUTRC = `set enable-bracketed-paste on
set enable-active-region off
set bell-style none
`;

/** The process group in the shell's foreground, when it is not the shell itself. */
function foregroundGroup(shellPid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${shellPid}/stat`, "utf8");
    // Fields after the command name, which is in parentheses and may contain spaces.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const group = Number(fields[5]);
    return Number.isInteger(group) && group > 0 && group !== shellPid
      ? group
      : undefined;
  } catch {
    // Not Linux. `ps` says the same thing on a Mac, where the tests run too.
    const probe = Bun.spawnSync(["ps", "-o", "tpgid=", "-p", String(shellPid)]);
    const group = Number(probe.stdout.toString().trim());
    return Number.isInteger(group) && group > 0 && group !== shellPid
      ? group
      : undefined;
  }
}

function clampSize(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * A command as it is typed: bracketed paste, so newlines, tabs and quotes arrive as text in the
 * shell's line rather than as Enter, completion or anything else. The one sequence that could end
 * the paste early is removed, and carriage returns become newlines.
 */
function typed(command: string): string {
  const text = command
    .replace(/\r\n?/g, "\n")
    .replaceAll("\x1b[201~", "")
    .replace(/\n+$/, "");
  // Ctrl-E Ctrl-U first: clear anything a person left half typed on the line.
  return `\x05\x15\x1b[200~${text}\x1b[201~\r`;
}

export function createLiveShell(options: LiveShellOptions) {
  let cols = DEFAULT_COLS;
  let rows = DEFAULT_ROWS;
  let running: Running | undefined;
  let atPrompt = false;
  let promptWaiters: Array<() => void> = [];
  let run: Run | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** What the terminal says when the shell being stopped has gone. */
  let endingReason: string | undefined;
  const viewers = new Set<Viewer>();

  const screen = new ScreenModel({
    cols,
    rows,
    scrollback: SCROLLBACK_LINES,
    allowProposedApi: true,
  });
  const serializer = new SerializeAddon();
  screen.loadAddon(
    serializer as unknown as Parameters<typeof screen.loadAddon>[0],
  );

  const scanner = createMarkScanner();
  let decoder = new TextDecoder();
  const encoder = new TextEncoder();

  function touch() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (viewers.size === 0 && !run && running) stopShell();
    }, IDLE_MS);
    // A shell nobody uses must not hold the computer's process open on its own.
    (idleTimer as { unref?: () => void }).unref?.();
  }

  /** Write to the screen model and every viewer, as if the shell had printed it. */
  function show(bytes: Uint8Array) {
    screen.write(bytes);
    for (const viewer of viewers) deliver(viewer, bytes);
  }

  function notice(text: string) {
    show(encoder.encode(`\r\n\x1b[2m${text}\x1b[0m\r\n`));
  }

  function deliver(viewer: Viewer, bytes: Uint8Array) {
    if (viewer.syncing) {
      viewer.pending.push(bytes);
      viewer.pendingBytes += bytes.byteLength;
      // A viewer whose first screen is slow to arrive is sent a fresher one rather than a backlog.
      if (viewer.pendingBytes > VIEWER_HIGH_WATER) {
        viewer.pending = [];
        viewer.pendingBytes = 0;
        viewer.behind = true;
      }
      return;
    }
    if (viewer.behind) return;
    if (viewer.unacked > VIEWER_HIGH_WATER) {
      viewer.behind = true;
      return;
    }
    viewer.unacked += bytes.byteLength;
    try {
      viewer.sink.binary(bytes);
    } catch {
      viewers.delete(viewer);
    }
  }

  /**
   * Send a viewer the screen as it is, then whatever arrived while it was being prepared.
   *
   * The screen model parses asynchronously. An empty write's callback runs once everything before it
   * is parsed and before anything after it is, so the screen serialized there is exactly the bytes
   * that came before the viewer asked, and the ones queued in `pending` are exactly the rest.
   */
  function sync(viewer: Viewer) {
    viewer.syncing = true;
    viewer.pending = [];
    viewer.pendingBytes = 0;
    screen.write("", () => {
      if (!viewers.has(viewer)) return;
      const snapshot = encoder.encode(
        serializer.serialize({ scrollback: SCROLLBACK_LINES }),
      );
      const pending = viewer.pending;
      const overflowed = viewer.behind;
      viewer.syncing = false;
      viewer.pending = [];
      viewer.pendingBytes = 0;
      viewer.behind = false;
      // The screen is sent whole whatever its size, so it is not counted against the high mark: a
      // long, colourful screen counted there would leave a viewer sent nothing but screens.
      viewer.unacked = 0;
      try {
        viewer.sink.text({ type: "snapshot", cols, rows });
        if (snapshot.byteLength > 0) viewer.sink.binary(snapshot);
        if (!overflowed) for (const bytes of pending) deliver(viewer, bytes);
        viewer.sink.text({ type: "ready" });
      } catch {
        viewers.delete(viewer);
        return;
      }
      // Bytes dropped while it waited: the screen it has is already stale, so send a fresh one.
      if (overflowed) sync(viewer);
    });
  }

  function onMark(mark: ShellMark) {
    if (mark.kind === "started") {
      atPrompt = false;
      if (run && run.phase === "echo") run.phase = "output";
      return;
    }
    if (mark.kind === "continued") {
      atPrompt = false;
      // The shell wants the rest of a command the Bot sent whole: it is unfinished, so abandon it.
      if (run && !run.incomplete) {
        run.incomplete = true;
        running?.terminal.write("\x03");
      }
      return;
    }
    atPrompt = true;
    const waiters = promptWaiters;
    promptWaiters = [];
    for (const wake of waiters) wake();
    if (run && mark.nonce === run.nonce) run.finish(mark.status);
  }

  function onText(text: string) {
    if (run?.phase !== "output") return;
    run.out += text;
    // Trimmed while it arrives, so a flood cannot grow without limit; the flag says it happened.
    if (run.out.length > MAX_HELD_OUTPUT) {
      run.out = run.out.slice(-MAX_KEPT_OUTPUT);
      run.dropped = true;
    }
  }

  function onData(bytes: Uint8Array) {
    show(bytes);
    for (const event of scanner.feed(decoder.decode(bytes, { stream: true }))) {
      if (event.type === "text") onText(event.text);
      else onMark(event.mark);
    }
  }

  function spawnShell(): Running {
    const directory = mkdtempSync(join(tmpdir(), ".openbot-shell-"));
    const turnFile = join(directory, "turn");
    const rcFile = join(directory, "bashrc");
    const inputrc = join(directory, "inputrc");
    writeFileSync(turnFile, "", { mode: 0o600 });
    writeFileSync(rcFile, startupFile(turnFile), { mode: 0o600 });
    writeFileSync(inputrc, INPUTRC, { mode: 0o600 });

    const base = options.env();
    const env: Record<string, string> = {
      // A pager waits for a key nobody is there to press; git asking for a password waits for ever.
      PAGER: "cat",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      ...base,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      INPUTRC: inputrc,
    };
    atPrompt = false;
    decoder = new TextDecoder();
    let readyResolve: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    promptWaiters.push(readyResolve);

    const child = Bun.spawn(
      [options.bash ?? findBash(), "--noprofile", "--rcfile", rcFile, "-i"],
      {
        cwd: options.cwd,
        env,
        terminal: {
          cols,
          rows,
          name: "xterm-256color",
          data: (_terminal, data) => onData(data),
        },
      },
    );
    const terminal = child.terminal;
    if (!terminal) throw new Error("The shell's terminal could not be opened.");
    child.unref();
    terminal.unref();
    const mine: Running = {
      process: child,
      terminal,
      directory,
      turnFile,
      startedAt: Date.now(),
      ready,
    };
    void child.exited.then((code) => onExit(mine, code));
    return mine;
  }

  function onExit(which: Running, code: number) {
    if (running !== which) return;
    running = undefined;
    atPrompt = false;
    try {
      which.terminal.close();
    } catch {
      // Already closed with the process.
    }
    rmSync(which.directory, { recursive: true, force: true });
    // The command that was running ended with the shell: `exit 3` is an answer, not a failure.
    run?.finish(code);
    const waiters = promptWaiters;
    promptWaiters = [];
    for (const wake of waiters) wake();
    if (disposed) return;
    // Said in the terminal, so a person watching knows why the prompt went. The next use starts a new one.
    notice(endingReason ?? SHELL_ENDED);
    endingReason = undefined;
  }

  /** The running shell, started if there is none. */
  function ensure(): Running {
    if (disposed) throw new Error("The shell has been closed.");
    if (!running) running = spawnShell();
    touch();
    return running;
  }

  function stopShell(reason?: string) {
    const current = running;
    if (!current) return;
    endingReason = reason;
    try {
      current.process.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }

  async function waitForPrompt(ms: number): Promise<boolean> {
    if (atPrompt) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        promptWaiters = promptWaiters.filter((wake) => wake !== done);
        resolve(atPrompt);
      }, ms);
      const done = () => {
        clearTimeout(timer);
        resolve(atPrompt);
      };
      promptWaiters.push(done);
    });
  }

  async function execute(input: {
    command: string;
    deadline: number;
    signal?: AbortSignal;
  }): Promise<CommandOutcome> {
    const nothing = (patch: Partial<CommandOutcome>): CommandOutcome => ({
      raw: "",
      dropped: false,
      exitCode: -1,
      timedOut: false,
      stopped: false,
      busy: false,
      incomplete: false,
      ...patch,
    });
    if (input.signal?.aborted) return nothing({ stopped: true });
    if (Date.now() >= input.deadline) return nothing({ timedOut: true });

    const shell = ensure();
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    const started = await Promise.race([
      shell.ready.then(() => true),
      new Promise<boolean>((resolve) => {
        startTimer = setTimeout(() => resolve(false), START_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(startTimer);
    if (!started || running !== shell)
      throw new Error("The computer's shell did not start.");
    if (!(await waitForPrompt(PROMPT_GRACE_MS))) return nothing({ busy: true });
    if (input.signal?.aborted) return nothing({ stopped: true });

    const nonce = crypto.randomUUID().replaceAll("-", "");
    writeFileSync(shell.turnFile, nonce, { mode: 0o600 });
    let finish: (status: number) => void = () => undefined;
    const ended = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const current: Run = {
      nonce,
      phase: "echo",
      out: "",
      dropped: false,
      incomplete: false,
      timedOut: false,
      stopped: false,
      finish: (status) => finish(status),
    };
    run = current;
    atPrompt = false;

    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const interrupt = () => {
      // Ctrl-C, as a person would; then the command's process group; then the shell itself.
      shell.terminal.write("\x03");
      timers.push(
        setTimeout(() => {
          const group = foregroundGroup(shell.process.pid);
          if (group !== undefined) {
            try {
              process.kill(-group, "SIGKILL");
            } catch {
              // Gone between the two questions.
            }
          }
          timers.push(
            setTimeout(
              () => stopShell(COMMAND_WOULD_NOT_STOP),
              INTERRUPT_GRACE_MS,
            ),
          );
        }, INTERRUPT_GRACE_MS),
      );
    };
    const onAbort = () => {
      if (current.timedOut || current.stopped) return;
      current.stopped = true;
      interrupt();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    timers.push(
      setTimeout(
        () => {
          if (current.timedOut || current.stopped) return;
          current.timedOut = true;
          interrupt();
        },
        Math.max(0, input.deadline - Date.now()),
      ),
    );

    shell.terminal.write(typed(input.command));
    const status = await ended;

    for (const timer of timers) clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    if (run === current) run = undefined;
    try {
      writeFileSync(shell.turnFile, "", { mode: 0o600 });
    } catch {
      // The shell went, and its directory with it.
    }
    touch();
    return {
      raw: current.out,
      dropped: current.dropped,
      exitCode: current.incomplete ? 2 : status,
      timedOut: current.timedOut,
      stopped: current.stopped,
      busy: false,
      incomplete: current.incomplete,
    };
  }

  return {
    /**
     * Type a command into the shell and wait for its end. One at a time: two of the Bot's commands
     * asked for together run one after the other, each within its own deadline.
     */
    run(input: {
      command: string;
      deadline: number;
      signal?: AbortSignal;
    }): Promise<CommandOutcome> {
      const next = queue.then(() => execute(input));
      queue = next.catch(() => undefined);
      return next;
    },

    /** A person's keystrokes. Whether they may type is the wheel's question, asked by the caller. */
    input(data: string) {
      ensure().terminal.write(data);
    },

    resize(nextCols: number, nextRows: number) {
      const c = clampSize(nextCols, MIN_COLS, MAX_COLS);
      const r = clampSize(nextRows, MIN_ROWS, MAX_ROWS);
      if (c === cols && r === rows) return;
      cols = c;
      rows = r;
      screen.resize(c, r);
      running?.terminal.resize(c, r);
    },

    /** Watch the shell. Starts one if there is none, so a viewer always has a prompt to look at. */
    attach(sink: ViewerSink): ViewerHandle {
      const viewer: Viewer = {
        sink,
        syncing: true,
        pending: [],
        pendingBytes: 0,
        unacked: 0,
        behind: false,
      };
      viewers.add(viewer);
      try {
        ensure();
      } catch (error) {
        viewers.delete(viewer);
        throw error;
      }
      sync(viewer);
      return {
        ack(bytes: number) {
          if (!Number.isFinite(bytes) || bytes <= 0) return;
          viewer.unacked = Math.max(0, viewer.unacked - bytes);
          if (
            viewer.behind &&
            !viewer.syncing &&
            viewer.unacked < VIEWER_LOW_WATER
          )
            sync(viewer);
        },
        detach() {
          viewers.delete(viewer);
          touch();
        },
      };
    },

    /** End the shell the Bot and its viewers were using. The next use starts a new one. */
    restart(reason: string) {
      stopShell(reason);
    },

    /** End it for good: the computer is done with this Bot. */
    dispose() {
      disposed = true;
      if (idleTimer) clearTimeout(idleTimer);
      viewers.clear();
      stopShell();
      screen.dispose();
    },
  };
}

export type LiveShell = ReturnType<typeof createLiveShell>;
