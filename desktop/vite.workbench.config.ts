// Workbench only. The shipped build uses vite.config.ts and never this file.
// Port 3021 because 3020 belongs to the app. WORKBENCH_PORT or --port picks another port, and
// WORKBENCH_APP_PORT picks the app server's port (3023 by default).
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
import { APP_PREFIX } from "./workbench/appContract";
import {
  busyPortMessage,
  isAlive,
  leaseDir,
  WORKBENCH_APP_PORT,
  WORKBENCH_PORT,
} from "./workbench/server";

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

const APP_ORIGIN = `http://127.0.0.1:${WORKBENCH_APP_PORT}`;
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
            `The app server does not answer on port ${WORKBENCH_APP_PORT}. Run bun run workbench in app/.`,
          );
        }
      });
    },
  };
}

// Vite restarts the server when the config file or a file it imports changes. A restart closes the
// port for a moment and stops and starts the app server, so the runs of other processes that share
// this server fail (ERR_CONNECTION_REFUSED, then 502 on /__app/ until the app is back). The server
// keeps its config instead and says once that a restart is needed. The imported files still get
// normal HMR: appContract.ts, for example, is also a module of the page.
function noConfigRestart(): Plugin {
  return {
    name: "workbench-no-config-restart",
    apply: "serve",
    configureServer(server) {
      const configFile = server.config.configFile;
      const deps = [...server.config.configFileDependencies];
      (server.config.configFileDependencies as string[]).length = 0;
      if (configFile) server.watcher.unwatch(configFile);
      const told = new Set<string>();
      const tell = (file: string) => {
        if (told.has(file)) return;
        told.add(file);
        server.config.logger.warn(
          `Workbench: ${file} changed. Stop and start the workbench to use the change.`,
        );
      };
      server.watcher.on("change", (file) => {
        if (deps.includes(file)) tell(file);
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
//
// It starts only after this server listens: a second run on a busy port must not touch the app
// server of the run that has the port. A busy port ends the run with one line, not a stack.
function appServer(): Plugin {
  return {
    name: "workbench-app-server",
    apply: "serve",
    configureServer(server) {
      const listen = server.listen.bind(server);
      server.listen = async (...args) => {
        try {
          await listen(...args);
        } catch (error) {
          const port = server.config.server.port ?? WORKBENCH_PORT;
          if (/already in use/.test(String((error as Error)?.message))) {
            console.error(busyPortMessage(port, "workbench"));
            process.exit(1);
          }
          throw error;
        }
        // Not awaited: ensureServer() waits for the app separately.
        void startAppServer(server);
        return server;
      };
    },
  };
}

async function startAppServer(server: ViteDevServer): Promise<void> {
  const logger = server.config.logger;
  // The resolved port, so `--port` alone is enough.
  const port = server.config.server.port ?? WORKBENCH_PORT;
  const pidPath = join(leaseDir(port), APP_PID_FILE);
  await stopEarlierAppServer(pidPath);
  if (await appAnswers()) return;

  const child: ChildProcess = spawn("bun", ["run", "workbench"], {
    cwd: join(desktopDir, "..", "app"),
    env: {
      ...process.env,
      WORKBENCH_PORT: String(port),
      WORKBENCH_APP_PORT: String(WORKBENCH_APP_PORT),
    },
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
    `Workbench: the app server did not answer on port ${WORKBENCH_APP_PORT}. The desktop scenes still work.\n${stderr}`,
  );
}

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    workbenchEnv(mode),
    noConfigRestart(),
    appFrames(),
    appServer(),
  ],
  root: desktopDir,
  clearScreen: false,
  server: {
    port: WORKBENCH_PORT,
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
