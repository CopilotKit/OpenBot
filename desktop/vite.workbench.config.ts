// Workbench only. The shipped build uses vite.config.ts and never this file.
// Port 3021 because 3020 belongs to the app.
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import {
  defineConfig,
  loadEnv,
  normalizePath,
  type Plugin,
  type ViteDevServer,
} from "vite";
import { APP_PREFIX, APP_SERVER_PORT } from "./workbench/appContract";
import { isAlive, leaseDir } from "./workbench/server";

const desktopDir = fileURLToPath(new URL(".", import.meta.url));
const srcDir = `${normalizePath(desktopDir).replace(/\/$/, "")}/src/`;

const ENV_NAMES = [
  "VITE_OPENBOT_CLOUD_ENABLED",
  "VITE_OPENBOT_CLOUD_URL",
  "VITE_OPENBOT_CLOUD_WEB_URL",
  "VITE_OPENBOT_SUPPORT_URL",
] as const;

// Vite may serialize `import.meta.env.*` define keys as static JSON in dev, so the four reads are
// replaced in the source text instead. A page can override each one with `globalThis.__workbenchEnv`.
function workbenchEnv(mode: string): Plugin {
  const loaded = loadEnv(mode, desktopDir, "VITE_");
  return {
    name: "workbench-env",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0] ?? id;
      if (!file.startsWith(srcDir) || !/\.tsx?$/.test(file)) return null;
      let out = code;
      for (const name of ENV_NAMES) {
        const fallback = JSON.stringify(loaded[name]) ?? "undefined";
        out = out.replaceAll(
          `import.meta.env.${name}`,
          `(globalThis.__workbenchEnv?.${name} ?? ${fallback})`,
        );
      }
      return out === code ? null : { code: out, map: null };
    },
  };
}

const APP_ORIGIN = `http://127.0.0.1:${APP_SERVER_PORT}`;
const APP_HTML_URL = `${APP_ORIGIN}${APP_PREFIX}`;
const APP_CLIENT_URL = `${APP_ORIGIN}${APP_PREFIX}@vite/client`;
const APP_POLL_MS = 250;
const APP_START_TIMEOUT_MS = 90_000;
const APP_STDERR_KEEP = 4096;
const APP_PID_FILE = "app-server.pid";

// The workbench's own paths. An iframe navigation to any other path is a route of the app.
const WORKBENCH_PATH = /^\/(?:workbench|src|node_modules|__app)(?:\/|$)|^\/@/;

/** True when an iframe navigation to this URL gets the app's HTML. */
function isAppRoute(url: string): boolean {
  const path = url.split(/[?#]/)[0] ?? url;
  return !WORKBENCH_PATH.test(path);
}

// An iframe navigation to an app route gets the app's HTML from the app server, so the frame's
// document path is the route and the frame stays same-origin. A full-page navigation inside the
// app frame (a sign-out, for example) gets the app again.
function appFrames(): Plugin {
  return {
    name: "workbench-app-frames",
    apply: "serve",
    configureServer(server) {
      // Added here, not in a returned hook, so it runs before Vite's own HTML fallback.
      server.middlewares.use(async (req, res, next) => {
        if (
          req.method !== "GET" ||
          req.headers["sec-fetch-dest"] !== "iframe" ||
          !isAppRoute(req.url ?? "/")
        ) {
          next();
          return;
        }
        try {
          const answer = await fetch(APP_HTML_URL, {
            headers: { accept: "text/html" },
          });
          if (!answer.ok) throw new Error(`status ${answer.status}`);
          const html = await answer.text();
          res.statusCode = 200;
          res.setHeader("content-type", "text/html");
          res.end(html);
        } catch {
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end(
            `The app server does not answer on port ${APP_SERVER_PORT}. Run bun run workbench in app/.`,
          );
        }
      });
    },
  };
}

async function appAnswers(): Promise<boolean> {
  try {
    return (await fetch(APP_CLIENT_URL)).ok;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
}

function readPid(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// An app server that an earlier workbench run started and did not stop (it was killed with
// SIGKILL, for example) is stopped, so a run never reuses a server with old settings.
async function stopEarlierAppServer(pidPath: string): Promise<void> {
  const pid = readPid(pidPath);
  if (pid === null) return;
  if (isAlive(pid) && (await appAnswers())) {
    killGroup(pid);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await appAnswers()))
      await sleep(APP_POLL_MS);
  }
  rmSync(pidPath, { force: true });
}

// Starts the app server (`bun run workbench` in app/) when it does not answer, so
// `bun run workbench` in desktop/ is still the one command. The app server stops when this server
// closes or this process ends. When the app server does not start, the desktop scenes still work.
function appServer(): Plugin {
  return {
    name: "workbench-app-server",
    apply: "serve",
    configureServer(server) {
      // Not awaited: this server listens at once, and ensureServer() waits for the app separately.
      void startAppServer(server);
    },
  };
}

async function startAppServer(server: ViteDevServer): Promise<void> {
  const logger = server.config.logger;
  const port = server.config.server.port ?? 3021;
  const pidPath = join(leaseDir(port), APP_PID_FILE);
  await stopEarlierAppServer(pidPath);
  if (await appAnswers()) return;

  const child: ChildProcess = spawn("bun", ["run", "workbench"], {
    cwd: join(desktopDir, "..", "app"),
    env: { ...process.env, WORKBENCH_PORT: String(port) },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  if (pid === undefined) {
    logger.error("Workbench: the app server did not start.");
    return;
  }
  try {
    writeFileSync(pidPath, String(pid));
  } catch {}

  let stderr = "";
  child.stdout?.resume();
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-APP_STDERR_KEEP);
  });

  let stopped = false;
  let exited = false;
  const onExit = () => stop();
  const onSigint = () => {
    stop();
    process.exit(130);
  };
  const onSigterm = () => {
    stop();
    process.exit(143);
  };
  function stop(): void {
    if (stopped) return;
    stopped = true;
    process.off("exit", onExit);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    server.httpServer?.off("close", onExit);
    if (!exited) killGroup(pid as number);
    rmSync(pidPath, { force: true });
  }
  child.on("exit", () => {
    exited = true;
    if (readPid(pidPath) === pid) rmSync(pidPath, { force: true });
  });
  server.httpServer?.once("close", onExit);
  process.once("exit", onExit);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const deadline = Date.now() + APP_START_TIMEOUT_MS;
  while (Date.now() < deadline && !exited && !stopped) {
    if (await appAnswers()) return;
    await sleep(APP_POLL_MS);
  }
  if (stopped) return;
  logger.error(
    `Workbench: the app server did not answer on port ${APP_SERVER_PORT}. The desktop scenes still work.\n${stderr}`,
  );
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), workbenchEnv(mode), appFrames(), appServer()],
  root: desktopDir,
  clearScreen: false,
  server: {
    port: 3021,
    strictPort: true,
    proxy: { "/__app": { target: APP_ORIGIN, ws: true } },
  },
  resolve: {
    alias: [
      {
        find: /^@tauri-apps\/api\/core$/,
        replacement: `${desktopDir}src/fakeNative/core.ts`,
      },
      {
        find: /^@tauri-apps\/api\/event$/,
        replacement: `${desktopDir}src/fakeNative/event.ts`,
      },
    ],
  },
}));
