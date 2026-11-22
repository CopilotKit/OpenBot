// Starts the workbench's Vite server, or reuses one that already runs. For the browser tests and the CLI.
//
// More than one process can use the same server: two CLI runs, or test files that run in
// parallel. So each ensureServer() call holds a lease, a file in
// `<tmpdir>/openbot-workbench-<port>/` named `<pid>-<random>.lease`. stop() removes its own lease
// and stops the server only when no lease of a live process remains. The process that stops last
// stops the server, also when another process started it. A lease of a dead process is stale: it
// is ignored and removed.
//
// The process that starts the server writes the server's pid in `server.pid`. A server without
// that file was started by a person (`bun run workbench`), and stop() never stops it.
//
// The workbench server starts the app server on port 3023 (see vite.workbench.config.ts), which
// writes its pid in `app-server.pid`. ensureServer() also waits for the app server, and stop()
// makes sure the app server stopped together with the workbench server.
//
// Set WORKBENCH_PORT to use a port other than 3021, and WORKBENCH_APP_PORT to use a port other
// than 3023 for the app server, for example to keep a run apart from others.
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
export const WORKBENCH_APP_PORT = appPort(process.env.WORKBENCH_APP_PORT);
export const WORKBENCH_URL = `http://localhost:${WORKBENCH_PORT}`;

const CLIENT_URL = `${WORKBENCH_URL}/@vite/client`;
const POLL_MS = 200;
const START_TIMEOUT_MS = 30_000;
const APP_CLIENT_URL = `${WORKBENCH_URL}/__app/@vite/client`;
const APP_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 5_000;

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

/** The app server's port from WORKBENCH_APP_PORT, or 3023 when it is not set. A bad value is an error. */
export function appPort(value: string | undefined): number {
  return portFrom("WORKBENCH_APP_PORT", value, DEFAULT_APP_PORT);
}

/** The one-line message when the port of the workbench server or of the app server is busy. */
export function busyPortMessage(
  port: number,
  server: "workbench" | "app",
): string {
  return server === "workbench"
    ? `Workbench: port ${port} is busy. Stop the program that uses it, or pick another port: WORKBENCH_PORT=<port> bun run workbench, or bun run workbench --port <port>.`
    : `Workbench: port ${port} for the app server is busy. Stop the program that uses it, or pick another port: WORKBENCH_APP_PORT=<port> bun run workbench.`;
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

/** The pid in `server.pid`, or null. */
export function readServerPid(dir: string): number | null {
  try {
    const pid = Number(readFileSync(join(dir, "server.pid"), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
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
 * `server.pid`: the caller stops that process.
 */
export function releaseLease(
  dir: string,
  own: string,
  alive: IsAlive = isAlive,
): number | null {
  rmSync(join(dir, own), { force: true });
  const plan = stopPlan(listDir(dir), readServerPid(dir), alive);
  for (const name of plan.stale) rmSync(join(dir, name), { force: true });
  if (plan.kill === null) {
    // A dead server's pid file only misleads the next run.
    const pid = readServerPid(dir);
    if (pid !== null && !alive(pid))
      rmSync(join(dir, "server.pid"), { force: true });
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

function dropStartLock(dir: string): void {
  rmSync(join(dir, "start.lock"), { force: true });
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
 * After the workbench server stopped: stops the app server it started, if that one still runs
 * (the workbench server was killed before it could stop it, for example).
 */
async function stopAppServer(dir: string): Promise<void> {
  const path = join(dir, "app-server.pid");
  let pid: number | null = null;
  try {
    pid = Number(readFileSync(path, "utf8").trim());
  } catch {}
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return;
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(50);
  if (isAlive(pid)) {
    // Its own process group: the app server's children stop too.
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
    const killDeadline = Date.now() + STOP_TIMEOUT_MS;
    while (isAlive(pid) && Date.now() < killDeadline) await Bun.sleep(50);
    if (isAlive(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
  }
  rmSync(path, { force: true });
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(50);
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    while (isAlive(pid)) await Bun.sleep(50);
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

export async function ensureServer(): Promise<WorkbenchServer> {
  const dir = leaseDir();
  const lease = takeLease(dir);
  let released = false;
  // Sync, so it also runs in the "exit" event: a caller that never calls stop() (or exits early)
  // still gives back its lease.
  const release = (): number | null => {
    if (released) return null;
    released = true;
    process.off("exit", onExit);
    return releaseLease(dir, lease);
  };
  const onExit = () => {
    const pid = release();
    if (pid !== null) signal(pid);
  };
  process.on("exit", onExit);
  // A reused server may still be starting the app server, so both paths wait for it.
  const handle = async (started: boolean): Promise<WorkbenchServer> => ({
    url: WORKBENCH_URL,
    started,
    app: await waitForApp(),
    stop: async () => {
      const pid = release();
      if (pid === null) return;
      signal(pid);
      await waitForExit(pid);
      await stopAppServer(dir);
    },
  });

  try {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await answers()) return handle(false);
      if (takeStartLock(dir)) {
        try {
          // Another process can have started it while this one waited for the lock.
          if (await answers()) return handle(false);
          await start(dir, deadline);
          return handle(true);
        } finally {
          dropStartLock(dir);
        }
      }
      // Another process is starting the server.
      await Bun.sleep(POLL_MS);
    }
    throw new Error(
      `The workbench server did not start in ${START_TIMEOUT_MS / 1000} s.`,
    );
  } catch (error) {
    release();
    throw error;
  }
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
    env: { ...process.env, WORKBENCH_APP_PORT: String(WORKBENCH_APP_PORT) },
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
  writeFileSync(join(dir, "server.pid"), String(proc.pid));

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
