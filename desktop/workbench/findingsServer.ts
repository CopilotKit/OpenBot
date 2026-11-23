// The Findings page's side of the workbench server (vite.workbench.config.ts imports it):
//
//   GET  /__workbench/findings         the newest findings.json under workbench-shots/check/
//   POST /__workbench/findings/run     starts `workbench:check` in the background (one at a time)
//   GET  /__workbench/findings/status  how far that run is
//
// The check is the CLI itself (shot.ts --all --check). It runs with this server's ports, so its
// ensureServer() takes a lease on this server and never starts another one or stops this one.
import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, relative } from "node:path";
import type { Plugin } from "vite";
import {
  FINDINGS_RUN_URL,
  FINDINGS_STATUS_URL,
  FINDINGS_URL,
} from "./findings";

/** Where `bun run workbench:check` writes, from the desktop folder. */
export const CHECK_OUT = join("workbench-shots", "check");

export const NO_FINDINGS_MESSAGE =
  "There are no findings yet. Press Run the check again, or run `cd desktop && bun run workbench:check`.";

/** The newest findings.json in `dir` or in a folder right under it, or null when there is none. */
export function newestFindings(
  dir: string,
): { path: string; mtimeMs: number } | null {
  const candidates = [join(dir, "findings.json")];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory())
        candidates.push(join(dir, entry.name, "findings.json"));
    }
  } catch {
    return null;
  }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const path of candidates) {
    try {
      const { mtimeMs } = statSync(path);
      if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
    } catch {}
  }
  return best;
}

export type CheckProgress = { done: number; total: number; scene: string };

/**
 * Reads shot.ts's progress line, `Scene 3/57: install-mac`, printed when a scene starts: two
 * scenes are done then.
 */
export function parseProgress(line: string): CheckProgress | null {
  const m = /^Scene (\d+)\/(\d+): (\S+)/.exec(line.trim());
  if (!m) return null;
  return { done: Number(m[1]) - 1, total: Number(m[2]), scene: m[3] as string };
}

export type CheckStatus = {
  running: boolean;
  done: number;
  total: number;
  /** The scene the check walks now. */
  scene: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** 0: no problems, 1: problems in the runs (findings.json is still written), else a failure. */
  exitCode: number | null;
  /** The last lines on stderr: the problems, or why the check failed. */
  stderr: string[];
};

const IDLE: CheckStatus = {
  running: false,
  done: 0,
  total: 0,
  scene: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  stderr: [],
};

const STDERR_LINES = 40;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

export type FindingsApiOptions = {
  desktopDir: string;
  /** The ports the check uses: this server's. */
  ports(): { workbench: number; app: number };
  /** The command that runs the check. Tests give another one. */
  command?: readonly string[];
};

export function findingsApi(options: FindingsApiOptions): Plugin {
  const outDir = join(options.desktopDir, CHECK_OUT);
  const command = options.command ?? [
    "bun",
    "workbench/shot.ts",
    "--all",
    "--check",
    "--out",
    CHECK_OUT,
  ];
  let status: CheckStatus = { ...IDLE };
  let child: ChildProcess | null = null;

  const start = (): void => {
    const { workbench, app } = options.ports();
    status = {
      ...IDLE,
      running: true,
      startedAt: new Date().toISOString(),
    };
    const [bin, ...args] = command;
    const proc = spawn(bin as string, args, {
      cwd: options.desktopDir,
      env: {
        ...process.env,
        WORKBENCH_PORT: String(workbench),
        WORKBENCH_APP_PORT: String(app),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    let out = "";
    let err = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const lines = out.split("\n");
      out = lines.pop() ?? "";
      for (const line of lines) {
        const progress = parseProgress(line);
        if (progress) status = { ...status, ...progress };
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString();
      const lines = err.split("\n");
      err = lines.pop() ?? "";
      status = {
        ...status,
        stderr: [...status.stderr, ...lines.filter(Boolean)].slice(
          -STDERR_LINES,
        ),
      };
    });
    const finish = (code: number | null, extra?: string) => {
      if (child !== proc) return;
      child = null;
      status = {
        ...status,
        running: false,
        done: code === 0 || code === 1 ? status.total : status.done,
        scene: null,
        finishedAt: new Date().toISOString(),
        exitCode: code ?? -1,
        stderr: extra
          ? [...status.stderr, extra].slice(-STDERR_LINES)
          : status.stderr,
      };
    };
    proc.on("error", (error) =>
      finish(-1, `The check did not start: ${error.message}`),
    );
    proc.on("exit", (code) => finish(code));
  };

  const handle = (req: IncomingMessage, res: ServerResponse): boolean => {
    const path = (req.url ?? "").split("?")[0];
    if (path === FINDINGS_URL && req.method === "GET") {
      const newest = newestFindings(outDir);
      if (!newest) {
        sendJson(res, 404, { error: NO_FINDINGS_MESSAGE });
        return true;
      }
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(newest.path, "utf8"));
      } catch {
        sendJson(res, 500, {
          error: `${relative(options.desktopDir, newest.path)} is not JSON. Run the check again.`,
        });
        return true;
      }
      sendJson(res, 200, {
        path: relative(options.desktopDir, newest.path),
        mtime: new Date(newest.mtimeMs).toISOString(),
        data,
      });
      return true;
    }
    if (path === FINDINGS_RUN_URL && req.method === "POST") {
      if (status.running) {
        sendJson(res, 409, { error: "A check already runs.", status });
        return true;
      }
      start();
      sendJson(res, 202, status);
      return true;
    }
    if (path === FINDINGS_STATUS_URL && req.method === "GET") {
      sendJson(res, 200, status);
      return true;
    }
    return false;
  };

  return {
    name: "workbench-findings",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!handle(req, res)) next();
      });
      // A check that still runs stops with this server: it holds a lease on it.
      const stop = () => {
        child?.kill("SIGTERM");
      };
      server.httpServer?.once("close", stop);
      process.once("exit", stop);
    },
  };
}
