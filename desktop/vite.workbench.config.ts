// Workbench only. The shipped build uses vite.config.ts and never this file.
// Port 3021 because 3020 belongs to the app. WORKBENCH_PORT or --port picks another port, and
// WORKBENCH_APP_PORT picks the app server's port (the workbench port + 2 by default, so 3023).
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import {
  defineConfig,
  loadEnv,
  normalizePath,
  type Plugin,
  type ViteDevServer,
} from "vite";
import { APP_PREFIX } from "./workbench/appContract";
import { workbenchEnvValues } from "./workbench/buildEnv";
import { noConfigRestart } from "./workbench/noConfigRestart";
import {
  APP_PID_FILE,
  appPort,
  busyPortMessage,
  leaseDir,
  portArg,
  readPidFile,
  stopEarlierAppServer,
  WORKBENCH_PORT,
  writePidFile,
} from "./workbench/server";

// `--port` wins over WORKBENCH_PORT. Read here too, so that the dependency cache, the app server's
// port and its pid file belong to the port this server listens on, not to 3021.
const PORT = portArg(process.argv) ?? WORKBENCH_PORT;
const APP_PORT = appPort(process.env.WORKBENCH_APP_PORT, PORT);

const desktopDir = fileURLToPath(new URL(".", import.meta.url));
const appSrcDir = normalizePath(join(desktopDir, "..", "app", "src"));
const srcDir = `${normalizePath(desktopDir).replace(/\/$/, "")}/src/`;

const ENV_NAMES = [
  "VITE_OPENBOT_CLOUD_ENABLED",
  "VITE_OPENBOT_CLOUD_URL",
  "VITE_OPENBOT_CLOUD_WEB_URL",
  "VITE_OPENBOT_SUPPORT_URL",
] as const;

// Vite may serialize `import.meta.env.*` define keys as static JSON in dev, so the four reads are
// replaced in the source text instead. A page can override each one with `globalThis.__workbenchEnv`.
// With no .env value, each starts as in a release installer (workbench/buildEnv.ts).
function workbenchEnv(mode: string): Plugin {
  const loaded = workbenchEnvValues(loadEnv(mode, desktopDir, "VITE_"));
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

const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const APP_HTML_URL = `${APP_ORIGIN}${APP_PREFIX}`;
const APP_CLIENT_URL = `${APP_ORIGIN}${APP_PREFIX}@vite/client`;
const APP_POLL_MS = 250;
const APP_START_TIMEOUT_MS = 90_000;
const APP_STDERR_KEEP = 4096;

// The workbench's own paths. An iframe navigation to any other path is a route of the app.
const WORKBENCH_PATH =
  /^\/(?:workbench|src|node_modules|__app|__workbench)(?:\/|$)|^\/@/;

/** True when an iframe navigation to this URL gets the app's HTML. */
function isAppRoute(url: string): boolean {
  const path = url.split(/[?#]/)[0] ?? url;
  return !WORKBENCH_PATH.test(path);
}

// Is this request the workbench's window frame loading a page? Browsers send `Sec-Fetch-Dest` only to
// secure origins: http://localhost is one, but http://<LAN address> is not, so a person on the office
// network opening the workbench by its address sends no `Sec-Fetch-Dest` at all. Without the header,
// an HTML navigation whose Referer is the workbench page, or an app page on this same host (a
// navigation inside the app frame), is the frame.
function isFrameNavigation(req: {
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  const dest = req.headers["sec-fetch-dest"];
  if (dest !== undefined) return dest === "iframe";
  const accept = String(req.headers.accept ?? "");
  const referer = req.headers.referer;
  if (!accept.includes("text/html") || typeof referer !== "string")
    return false;
  let from: URL;
  try {
    from = new URL(referer);
  } catch {
    return false;
  }
  if (from.host !== req.headers.host) return false;
  return from.pathname.startsWith(HOME) || isAppRoute(from.pathname);
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
          !isFrameNavigation(req) ||
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
            `The app server does not answer on port ${APP_PORT}. Look in ${join(leaseDir(PORT), "server.log")}, then stop and start the workbench.`,
          );
        }
      });
    },
  };
}

// `bun run desktop-workbench` lands on the workbench: "/" (outside a frame) answers 302 to "/workbench/" with
// the same query, and the startup output names /workbench/ as the link to open. An iframe still
// gets the app at "/" (appFrames), so the app's own home route keeps working.
const HOME = "/workbench/";

function workbenchHome(): Plugin {
  return {
    name: "workbench-home",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "/";
        const path = url.split(/[?#]/)[0];
        if (
          path !== "/" ||
          (req.method !== "GET" && req.method !== "HEAD") ||
          isFrameNavigation(req)
        ) {
          next();
          return;
        }
        const query = url.slice(path.length);
        res.statusCode = 302;
        res.setHeader("location", `${HOME}${query}`);
        res.end();
      });
      // Vite prints its URLs after the server listens; print the workbench page under them.
      const printUrls = server.printUrls.bind(server);
      server.printUrls = () => {
        printUrls();
        const port = server.config.server.port ?? PORT;
        server.config.logger.info(
          `\n  Workbench: http://localhost:${port}${HOME}\n`,
        );
      };
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

// Starts the app server (`bun run desktop-workbench` in app/) when it does not answer, so
// `bun run desktop-workbench` in desktop/ is still the one command. The app server stops when this server
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
          const port = server.config.server.port ?? PORT;
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
  const port = server.config.server.port ?? PORT;
  const dir = leaseDir(port);
  const pidPath = join(dir, APP_PID_FILE);
  await stopEarlierAppServer(pidPath);
  // Not ours: another workbench's app server, or another program. Reusing it would stop it with
  // this server, or leave it running when its owner thinks it stopped.
  if (await appAnswers()) {
    logger.error(busyPortMessage(APP_PORT, "app"));
    return;
  }

  const child: ChildProcess = spawn("bun", ["run", "desktop-workbench"], {
    cwd: join(desktopDir, "..", "app"),
    env: {
      ...process.env,
      WORKBENCH_PORT: String(port),
      WORKBENCH_APP_PORT: String(APP_PORT),
      // `bun test` sets NODE_ENV=test, and Vite puts NODE_ENV in its dependency cache hash: the
      // same value for every app server keeps one cache (spawnShared in server.ts does the same).
      NODE_ENV: "development",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  if (pid === undefined) {
    logger.error("Workbench: the app server did not start.");
    return;
  }
  // A server that a person started has no lease folder yet: without the folder the pid file was
  // never written, and nothing could stop an app server that outlived this server.
  try {
    mkdirSync(dir, { recursive: true });
    writePidFile(pidPath, pid);
  } catch {}

  let stderr = "";
  // The app server's own log is dropped, except the lines that say it optimized dependencies or
  // reloaded the page: a reload of the app frame during a shot shows in server.log.
  child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (/optimiz|reload/i.test(line))
        logger.info(`Workbench app server: ${line.trim()}`);
    }
  });
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
    // The pid file stays until the app server exits: if it does not end on this SIGTERM,
    // ensureServer()'s stop() (or the next start) still finds it and stops it.
    if (!exited) killGroup(pid as number);
  }
  child.on("exit", (code, signal) => {
    exited = true;
    if (readPidFile(pidPath)?.pid === pid) rmSync(pidPath, { force: true });
    // An app server that ends while this server runs leaves every app frame without its files.
    if (!stopped)
      logger.error(
        `Workbench: the app server stopped (code ${code}, signal ${signal}).\n${stderr}`,
      );
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
    `Workbench: the app server did not answer on port ${APP_PORT}. The desktop scenes still work.\n${stderr}`,
  );
}

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    // The workbench page uses the app's components and theme (app/workbench/page.css).
    tailwindcss(),
    workbenchEnv(mode),
    noConfigRestart(),
    workbenchHome(),
    appFrames(),
    appServer(),
  ],
  root: desktopDir,
  // A dependency cache for each port: a second workbench (another port, the same checkout) never
  // optimizes the dependencies again in the folder that this server serves them from.
  cacheDir: join(desktopDir, "node_modules", ".vite-workbench", String(PORT)),
  clearScreen: false,
  server: {
    port: PORT,
    strictPort: true,
    proxy: { "/__app": { target: APP_ORIGIN, ws: true } },
  },
  resolve: {
    // One React: the app's components import it from app/node_modules, the workbench from
    // desktop/node_modules. Two copies fail with "Invalid hook call". tests/support/one-react.ts
    // does the same for bun test.
    dedupe: ["react", "react-dom"],
    alias: [
      {
        find: /^@tauri-apps\/api\/core$/,
        replacement: `${desktopDir}src/fakeNative/core.ts`,
      },
      {
        find: /^@tauri-apps\/api\/event$/,
        replacement: `${desktopDir}src/fakeNative/event.ts`,
      },
      // The app's components, as the app imports them (`@/components/ui/button`).
      { find: /^@\//, replacement: `${appSrcDir}/` },
    ],
  },
}));
