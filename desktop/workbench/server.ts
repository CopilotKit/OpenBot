// Starts the workbench's Vite server, or reuses one that already runs. For the browser tests and the CLI.
//
// More than one process can use the same server: two CLI runs, or test files that run in
// parallel. So each ensureServer() call holds a lease, a file in
// `<tmpdir>/openbot-workbench-<port>/` named `<pid>-<random>.lease`. stop() removes its own lease
// and stops the server only when no lease of a live process remains. The process that stops last
// stops the server, also when another process started it. A lease of a dead process is stale: it
// is ignored and removed.
//
// Stop and reuse never overlap: stop() holds the start lock (`start.lock`) from the moment it
// removes its lease until the server and its app server stopped, and ensureServer() decides to
// reuse or start only while it holds the same lock, after it wrote its lease. So a process never
// reuses a server that another process is about to stop, and a stop never touches the server or
// the app server that another process started after it.
//
// The process that starts the server writes the server's pid in `server.pid`. A server without
// that file was started by a person (`bun run desktop-workbench`), and stop() never stops it. A pid file
// also holds the start time of its process, so that a pid that the system gave to another process
// later is never signalled.
//
// The workbench server starts the app server (see vite.workbench.config.ts), which writes its pid
// in `app-server.pid`. ensureServer() also waits for the app server, and stop() makes sure the app
// server stopped together with the workbench server.
//
// Set WORKBENCH_PORT to use a port other than 3021. The app server's port is the workbench port
// + 2 (3023), or WORKBENCH_APP_PORT, for example to keep a run apart from others.
export { sharedChromium } from "../../tests/support/shared-browser";

import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_WORKBENCH_PORT = 3021;
export const DEFAULT_APP_PORT = 3023;

export const WORKBENCH_PORT = workbenchPort(process.env.WORKBENCH_PORT);
export const WORKBENCH_APP_PORT = appPort(
  process.env.WORKBENCH_APP_PORT,
  WORKBENCH_PORT,
);
export const WORKBENCH_URL = `http://localhost:${WORKBENCH_PORT}`;

const CLIENT_URL = `${WORKBENCH_URL}/@vite/client`;
const POLL_MS = 200;
const START_TIMEOUT_MS = 30_000;
const APP_CLIENT_URL = `${WORKBENCH_URL}/__app/@vite/client`;
const APP_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 5_000;
/** How long ensureServer() and stop() wait for the start lock: another process's start or stop. */
const LOCK_TIMEOUT_MS = START_TIMEOUT_MS + 6 * STOP_TIMEOUT_MS;

export const APP_PID_FILE = "app-server.pid";

/**
 * The time a test hook that calls ensureServer() needs: the start lock, a server start, the app
 * server, a browser. bun gives a hook 5 s by default. A hook that runs longer fails the file's
 * tests, and bun goes on with the next file while the hook still runs.
 */
export const HOOK_START_MS =
  LOCK_TIMEOUT_MS + START_TIMEOUT_MS + APP_TIMEOUT_MS + 30_000;
/** The time a test hook needs to close its browser and stop() the server, lock included. */
export const HOOK_STOP_MS = LOCK_TIMEOUT_MS + 4 * STOP_TIMEOUT_MS;

// The desktop folder: this file is desktop/workbench/server.ts.
const DESKTOP_DIR = `${import.meta.dir}/..`;

function portFrom(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a port number, not "${value}".`);
  }
  return port;
}

/** The port from WORKBENCH_PORT, or 3021 when it is not set. A bad value is an error. */
export function workbenchPort(value: string | undefined): number {
  return portFrom("WORKBENCH_PORT", value, DEFAULT_WORKBENCH_PORT);
}

/**
 * The app server's port from WORKBENCH_APP_PORT. When it is not set: the workbench port + 2, so
 * 3023 for 3021, and two workbenches on two ports never share one app server. A bad value is an
 * error.
 */
export function appPort(
  value: string | undefined,
  workbench: number = DEFAULT_WORKBENCH_PORT,
): number {
  const fallback = workbench + 2 <= 65_535 ? workbench + 2 : workbench - 2;
  return portFrom("WORKBENCH_APP_PORT", value, fallback);
}

/** The port after `--port` (or in `--port=<p>`) in a command line, or null. A bad value is an error. */
export function portArg(argv: readonly string[]): number | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = arg.startsWith("--port=")
      ? arg.slice("--port=".length)
      : arg === "--port"
        ? argv[i + 1]
        : undefined;
    if (value !== undefined) return portFrom("--port", value, 0);
  }
  return null;
}

/** The one-line message when the port of the workbench server or of the app server is busy. */
export function busyPortMessage(
  port: number,
  server: "workbench" | "app",
): string {
  return server === "workbench"
    ? `Workbench: port ${port} is busy. Stop the program that uses it, or pick another port: WORKBENCH_PORT=<port> bun run desktop-workbench, or bun run desktop-workbench --port <port>.`
    : `Workbench: port ${port} for the app server is busy. Stop the program that uses it (another workbench's app server, for example), or pick another port: WORKBENCH_APP_PORT=<port> bun run desktop-workbench.`;
}

/** The folder of the leases, `server.pid` and the start lock of one port. */
export function leaseDir(port: number = WORKBENCH_PORT): string {
  return join(tmpdir(), `openbot-workbench-${port}`);
}

/** The pid in a lease file name `<pid>-<random>.lease`, or null when the name is not a lease. */
export function leasePid(name: string): number | null {
  const m = /^(\d+)-[\w]+\.lease$/.exec(name);
  return m ? Number(m[1]) : null;
}

export type IsAlive = (pid: number) => boolean;

/** True when a process with this pid runs. A process of another user also counts. */
export const isAlive: IsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
};

/** When a process started, as the system says, or null when it cannot say. */
export type StartOf = (pid: number) => string | null;

/**
 * When the process with this pid started, or null when the system cannot say (no such process, or
 * no `ps`). Two processes with the same pid never have the same start time.
 */
export const processStart: StartOf = (pid) => {
  try {
    if (process.platform === "linux") {
      // Field 22 of /proc/<pid>/stat, counted after the ")" that ends field 2 (the name).
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
    }
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
};

/** What a pid file holds: the pid, and the start time of that process when it was known. */
export type PidRecord = { pid: number; start: string | null };

/** Writes `<pid>` and the process's start time in a pid file. */
export function writePidFile(
  path: string,
  pid: number,
  startOf: StartOf = processStart,
): void {
  writeFileSync(path, `${pid}\n${startOf(pid) ?? ""}\n`);
}

/** The pid file's record, or null when there is no file or no pid in it. */
export function readPidFile(path: string): PidRecord | null {
  try {
    const [first, second] = readFileSync(path, "utf8").split("\n");
    const pid = Number(first?.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const start = second?.trim();
    return { pid, start: start ? start : null };
  } catch {
    return null;
  }
}

/**
 * The record's pid when that process still runs and is the same process: its start time is the
 * one in the file. Null for a dead pid, and for a pid that the system gave to another process (a
 * stale pid file after a crash). A record without a start time is checked by its pid only.
 */
export function livePid(
  record: PidRecord | null,
  alive: IsAlive,
  startOf: StartOf = processStart,
): number | null {
  if (record === null || !alive(record.pid)) return null;
  if (record.start !== null) {
    const now = startOf(record.pid);
    if (now !== null && now !== record.start) return null;
  }
  return record.pid;
}

/** Sorts the files of the lease folder into live and stale leases. Other files are left out. */
export function sortLeases(
  names: readonly string[],
  alive: IsAlive,
): { live: string[]; stale: string[] } {
  const live: string[] = [];
  const stale: string[] = [];
  for (const name of names) {
    const pid = leasePid(name);
    if (pid === null) continue;
    (alive(pid) ? live : stale).push(name);
  }
  return { live, stale };
}

/**
 * What stop() does after it removed its own lease: `kill` is the server pid to stop, or null.
 * It stops the server only when no live lease remains and `server.pid` names a live process.
 */
export function stopPlan(
  names: readonly string[],
  serverPid: number | null,
  alive: IsAlive,
): { kill: number | null; stale: string[] } {
  const { live, stale } = sortLeases(names, alive);
  const kill =
    live.length === 0 && serverPid !== null && alive(serverPid)
      ? serverPid
      : null;
  return { kill, stale };
}

/** The pid in `server.pid` when it is still the process that file names, or null. */
export function readServerPid(
  dir: string,
  alive: IsAlive = isAlive,
  startOf: StartOf = processStart,
): number | null {
  return livePid(readPidFile(join(dir, "server.pid")), alive, startOf);
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Writes a new lease for this process and gives its file name. */
export function takeLease(dir: string, pid: number = process.pid): string {
  mkdirSync(dir, { recursive: true });
  const name = `${pid}-${crypto.randomUUID().replaceAll("-", "")}.lease`;
  writeFileSync(join(dir, name), "");
  return name;
}

/**
 * Removes the lease `own` and the stale leases. Gives the server pid to stop, or null when a live
 * lease remains or this tool did not start the server. When it gives a pid, it also removes
 * `server.pid`: the caller stops that process. Call it only while holding the start lock.
 */
export function releaseLease(
  dir: string,
  own: string,
  alive: IsAlive = isAlive,
  startOf: StartOf = processStart,
): number | null {
  rmSync(join(dir, own), { force: true });
  const serverPid = readServerPid(dir, alive, startOf);
  const plan = stopPlan(listDir(dir), serverPid, alive);
  for (const name of plan.stale) rmSync(join(dir, name), { force: true });
  if (plan.kill === null) {
    // A pid file of a dead server (or of a pid now used by another process) only misleads the
    // next run.
    if (serverPid === null) rmSync(join(dir, "server.pid"), { force: true });
    return null;
  }
  rmSync(join(dir, "server.pid"), { force: true });
  return plan.kill;
}

/**
 * Takes the start lock, so that only one process starts the server. Gives false when a live
 * process holds it. A lock of a dead process is removed and taken.
 */
export function takeStartLock(
  dir: string,
  alive: IsAlive = isAlive,
  pid: number = process.pid,
): boolean {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "start.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(pid));
      closeSync(fd);
      return true;
    } catch {
      let holder = Number.NaN;
      try {
        holder = Number(readFileSync(path, "utf8").trim());
      } catch {
        // The holder removed it in between: try again.
        continue;
      }
      // A lock with no pid yet is being written: its holder is alive.
      if (!Number.isInteger(holder) || holder <= 0 || alive(holder))
        return false;
      rmSync(path, { force: true });
    }
  }
  return false;
}

/** How long the exit hook waits for the start lock, in milliseconds. */
const EXIT_LOCK_WAIT_MS = 1_000;

/** takeStartLock, tried again for up to `waitMs`: for the exit hook, which cannot await. */
export function takeStartLockSync(
  dir: string,
  waitMs: number = EXIT_LOCK_WAIT_MS,
  alive: IsAlive = isAlive,
  pid: number = process.pid,
): boolean {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (takeStartLock(dir, alive, pid)) return true;
    if (Date.now() >= deadline) return false;
    Bun.sleepSync(25);
  }
}

function dropStartLock(dir: string): void {
  rmSync(join(dir, "start.lock"), { force: true });
}

export type LockOptions = {
  alive?: IsAlive;
  pid?: number;
  timeoutMs?: number;
  pollMs?: number;
};

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Runs `fn` while holding the start lock. Waits for the lock, and fails when it stays taken. */
export async function withStartLock<T>(
  dir: string,
  fn: () => Promise<T>,
  {
    alive = isAlive,
    pid = process.pid,
    timeoutMs = LOCK_TIMEOUT_MS,
    pollMs = POLL_MS,
  }: LockOptions = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (!takeStartLock(dir, alive, pid)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `The workbench start lock (${join(dir, "start.lock")}) stayed taken for ${timeoutMs / 1000} s.`,
      );
    }
    await sleep(pollMs);
  }
  try {
    return await fn();
  } finally {
    dropStartLock(dir);
  }
}

/**
 * The decision of ensureServer(), after it wrote its lease: reuse the server that answers, or
 * start one. Under the start lock, so a stop() that is under way ends before this looks. Gives
 * true when it started the server.
 */
export function reuseOrStart(
  dir: string,
  deps: { answers(): Promise<boolean>; start(): Promise<void> },
  lock: LockOptions = {},
): Promise<boolean> {
  return withStartLock(
    dir,
    async () => {
      if (await deps.answers()) return false;
      await deps.start();
      return true;
    },
    lock,
  );
}

export type StopDeps = {
  alive: IsAlive;
  startOf: StartOf;
  signal(pid: number): void;
  waitForExit(pid: number): Promise<void>;
  /** Stops the app server `app` (null: none was recorded) after the workbench server stopped. */
  stopApp(app: PidRecord | null, dir: string): Promise<void>;
};

/**
 * stop(): gives back the lease `own`, and stops the server and its app server when no other live
 * lease remains. Under the start lock, from the lease scan to the app server's end, so no process
 * reuses this server in between and no new server starts before the old one is gone. Gives the
 * pid it stopped, or null.
 */
export function stopShared(
  dir: string,
  own: string,
  deps: StopDeps,
  lock: LockOptions = {},
): Promise<number | null> {
  return withStartLock(
    dir,
    async () => {
      const kill = releaseLease(dir, own, deps.alive, deps.startOf);
      if (kill === null) return null;
      // The app server of this server, read before the server stops: its file goes away with it.
      const app = readPidFile(join(dir, APP_PID_FILE));
      deps.signal(kill);
      await deps.waitForExit(kill);
      await deps.stopApp(app, dir);
      return kill;
    },
    { alive: deps.alive, ...lock },
  );
}

async function answers(): Promise<boolean> {
  try {
    return (await fetch(CLIENT_URL)).ok;
  } catch {
    return false;
  }
}

/** Waits until the app server answers through the workbench server. False after 90 s. */
async function waitForApp(): Promise<boolean> {
  const deadline = Date.now() + APP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(APP_CLIENT_URL)).ok) return true;
    } catch {}
    await Bun.sleep(POLL_MS);
  }
  return false;
}

/**
 * After the workbench server stopped: stops the app server `app` that it started, if that one
 * still runs (the workbench server was killed before it could stop it, or the app server did not
 * end on the workbench server's SIGTERM, for example). `app` was read before the workbench server
 * stopped, so this never signals an app server that a later workbench server started.
 */
export async function stopAppServer(
  recorded: PidRecord | null,
  dir: string,
  alive: IsAlive = isAlive,
  startOf: StartOf = processStart,
): Promise<void> {
  const path = join(dir, APP_PID_FILE);
  // No record before the stop: the workbench server may have started its app server after that
  // read. No other workbench server can start under the start lock, so a file now is its.
  const app = recorded ?? readPidFile(path);
  if (app === null) return;
  const ours = () => livePid(app, alive, startOf) !== null;
  // A pid that is no longer this app server (it exited, and the system may have given the pid to
  // another process) is never signalled.
  if (ours()) {
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (alive(app.pid) && Date.now() < deadline) await sleep(50);
    if (ours()) {
      // Its own process group: the app server's children stop too.
      try {
        process.kill(-app.pid, "SIGTERM");
      } catch {}
      const killDeadline = Date.now() + STOP_TIMEOUT_MS;
      while (alive(app.pid) && Date.now() < killDeadline) await sleep(50);
      if (ours()) {
        try {
          process.kill(-app.pid, "SIGKILL");
        } catch {}
      }
    }
  }
  // Only the file of this app server: never the file of one that started after it.
  if (readPidFile(path)?.pid === app.pid) rmSync(path, { force: true });
}

/** Signals a process group. */
export type SignalGroup = (pid: number, signal: "SIGTERM" | "SIGKILL") => void;

const signalGroup: SignalGroup = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch {}
};

/**
 * Before a workbench server starts its app server: stops the app server that an earlier run
 * recorded in `pidPath` and did not stop (it was killed with SIGKILL, for example), so a run never
 * reuses one with old settings and two never fight for the port. A live, verified pid is stopped
 * also when it does not answer yet: it may still be starting, or hung. The file goes only after
 * that process is gone, or when its pid is dead or now another process's.
 */
export async function stopEarlierAppServer(
  pidPath: string,
  {
    alive = isAlive,
    startOf = processStart,
    signal = signalGroup,
    timeoutMs = STOP_TIMEOUT_MS,
  }: {
    alive?: IsAlive;
    startOf?: StartOf;
    signal?: SignalGroup;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const record = readPidFile(pidPath);
  if (record === null) return;
  const ours = () => livePid(record, alive, startOf) !== null;
  const gone = async () => {
    const deadline = Date.now() + timeoutMs;
    while (ours() && Date.now() < deadline) await sleep(50);
    return !ours();
  };
  if (ours()) {
    // Its own process group: the app server's children stop too.
    signal(record.pid, "SIGTERM");
    if (!(await gone())) {
      signal(record.pid, "SIGKILL");
      // Still there after SIGKILL: keep the record, so the next run tries again.
      if (!(await gone())) return;
    }
  }
  if (readPidFile(pidPath)?.pid === record.pid)
    rmSync(pidPath, { force: true });
}

/**
 * Waits for a stopped server to exit: SIGKILL after STOP_TIMEOUT_MS, and then at most that long
 * again. A process nobody reaps (a zombie, under a PID 1 that is not an init) still answers
 * `kill(pid, 0)`, so a wait with no limit could hang the stop.
 */
async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isAlive(pid) && Date.now() < deadline) await sleep(50);
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    const killDeadline = Date.now() + STOP_TIMEOUT_MS;
    while (isAlive(pid) && Date.now() < killDeadline) await sleep(50);
  }
}

function signal(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}

export type WorkbenchServer = {
  url: string;
  /** True when this call started the server. */
  started: boolean;
  /** True when the app server answered through the workbench server. */
  app: boolean;
  /** Gives back the lease. Stops the server when no other live process holds a lease. */
  stop(): Promise<void>;
};

const REAL_STOP: StopDeps = {
  alive: isAlive,
  startOf: processStart,
  signal,
  waitForExit,
  stopApp: (app, dir) => stopAppServer(app, dir),
};

export async function ensureServer(): Promise<WorkbenchServer> {
  const dir = leaseDir();
  const lease = takeLease(dir);
  let released = false;
  const giveBack = () => {
    released = true;
    process.off("exit", onExit);
  };
  // Sync, so it runs in the "exit" event: a caller that never calls stop() (or exits early, by
  // `process.exit`) still gives back its lease. `bun test` does not emit "exit": a test file must
  // call stop(). It waits a short time for the start lock: a stopper that saw this lease holds it
  // only for its scan. Still without the lock, it only removes its lease: the holder is starting
  // (with a lease of its own) or stopping the server already.
  const onExit = () => {
    if (released) return;
    giveBack();
    if (!takeStartLockSync(dir)) {
      rmSync(join(dir, lease), { force: true });
      return;
    }
    try {
      const pid = releaseLease(dir, lease);
      if (pid !== null) signal(pid);
    } finally {
      dropStartLock(dir);
    }
  };
  process.on("exit", onExit);

  let started: boolean;
  try {
    started = await reuseOrStart(dir, {
      answers,
      start: () => start(dir, Date.now() + START_TIMEOUT_MS),
    });
  } catch (error) {
    giveBack();
    rmSync(join(dir, lease), { force: true });
    throw error;
  }
  // After the lock: a reused server may still be starting the app server, so both paths wait.
  return {
    url: WORKBENCH_URL,
    started,
    app: await waitForApp(),
    stop: async () => {
      if (released) return;
      giveBack();
      try {
        await stopShared(dir, lease, REAL_STOP);
      } catch (error) {
        rmSync(join(dir, lease), { force: true });
        throw error;
      }
    },
  };
}

/**
 * Starts a process that other processes share, with its output in `logPath`.
 *
 * The process gets its own process group. Without that, it is in the group of the process that
 * started it, and a signal to that group (Ctrl+C, or a tool that stops a command and its group at
 * a timeout) also stops it, while other processes still hold leases on it.
 */
export function spawnShared(
  cmd: string[],
  cwd: string,
  logPath: string,
): Bun.Subprocess {
  const log = Bun.file(logPath);
  const proc = Bun.spawn(cmd, {
    cwd,
    env: {
      ...process.env,
      WORKBENCH_APP_PORT: String(WORKBENCH_APP_PORT),
      // `bun test` sets NODE_ENV=test. Vite puts NODE_ENV in the hash of its dependency cache, so
      // a server that a test started and one that a person started optimized the dependencies
      // again on each start, under the feet of the other server's open windows.
      NODE_ENV: "development",
    },
    detached: true,
    stdin: "ignore",
    stdout: log,
    stderr: log,
  });
  proc.unref();
  return proc;
}

/** Starts Vite and writes its pid in `server.pid`. The server outlives this process if others hold leases. */
async function start(dir: string, deadline: number): Promise<void> {
  // The server writes to a file, not to pipes: a pipe would break when this process exits
  // while other processes still use the server.
  const logPath = join(dir, "server.log");
  writeFileSync(logPath, "");
  // `bun x vite` finds node_modules/.bin/vite of the desktop package from this cwd. --port wins
  // over the port in the config file.
  const proc = spawnShared(
    [
      "bun",
      "x",
      "vite",
      "--config",
      "vite.workbench.config.ts",
      "--port",
      String(WORKBENCH_PORT),
      "--strictPort",
    ],
    DESKTOP_DIR,
    logPath,
  );
  writePidFile(join(dir, "server.pid"), proc.pid);

  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    if (await answers()) return;
    await Bun.sleep(POLL_MS);
  }
  proc.kill();
  await proc.exited;
  rmSync(join(dir, "server.pid"), { force: true });
  let output = "";
  try {
    output = readFileSync(logPath, "utf8");
  } catch {}
  throw new Error(`The workbench server did not start.\n${output}`);
}
