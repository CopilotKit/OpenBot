// Workbench only. The shipped build uses vite.config.ts and never this file.
// Port 3023, behind the workbench server on 3021, which proxies /__app/ to it. WORKBENCH_APP_PORT
// and WORKBENCH_PORT change the two ports; the desktop workbench sets both when it starts this one.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { noConfigRestart } from "../desktop/workbench/noConfigRestart";
import {
  appPort,
  busyPortMessage,
  workbenchPort,
} from "../desktop/workbench/server";
import { routeCodeSplittingOptions } from "./vite.config";
import { readDesktopPageScripts } from "./workbench/rustScripts";

// The ports, the busy-port message and the no-restart plugin are the desktop workbench's own, so
// the two servers never disagree on a port or a message.
const WORKBENCH_PORT = workbenchPort(process.env.WORKBENCH_PORT);
// The desktop workbench sets WORKBENCH_APP_PORT when it starts this server.
const APP_PORT = appPort(process.env.WORKBENCH_APP_PORT, WORKBENCH_PORT);

// A busy port ends the run with one line, not a stack.
function busyPort(): Plugin {
  return {
    name: "workbench-busy-port",
    apply: "serve",
    configureServer(server) {
      const listen = server.listen.bind(server);
      server.listen = async (...args) => {
        try {
          return await listen(...args);
        } catch (error) {
          if (/already in use/.test(String((error as Error)?.message))) {
            console.error(busyPortMessage(APP_PORT, "app"));
            process.exit(1);
          }
          throw error;
        }
      };
    },
  };
}

const appDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(appDir, "..");

const MAIN_TAG = '<script type="module" src="/src/main.tsx"></script>';
const BOOT_TAGS = [
  '<script type="module" src="/workbench/frameBoot.ts"></script>',
  MAIN_TAG,
  '<script type="module" src="/workbench/appBoot.ts"></script>',
].join("\n    ");

// The fakes boot before the app's own entry, and the preboot runs before the
// app's inline theme script, so the first paint already uses the scene's storage and theme. The
// last module, after the entry, tells the page that the frame booted once the app drew in #root.
function workbenchHtml(): Plugin {
  const preboot = readFileSync(
    path.join(appDir, "workbench", "preboot.js"),
    "utf8",
  );
  return {
    name: "workbench-html",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (!html.includes(MAIN_TAG)) {
          throw new Error(
            "Workbench: app/index.html no longer loads /src/main.tsx as the workbench expects.",
          );
        }
        return {
          html: html.replace(MAIN_TAG, BOOT_TAGS),
          tags: [
            { tag: "script", children: preboot, injectTo: "head-prepend" },
          ],
        };
      },
    },
  };
}

const DESKTOP_PAGES = "virtual:workbench-desktop-pages";
const RESOLVED_DESKTOP_PAGES = `\0${DESKTOP_PAGES}`;

// The scripts OpenBot Desktop runs in the app's page, read from the Rust source.
function desktopPages(): Plugin {
  return {
    name: "workbench-desktop-pages",
    resolveId(id) {
      return id === DESKTOP_PAGES ? RESOLVED_DESKTOP_PAGES : null;
    },
    load(id) {
      if (id !== RESOLVED_DESKTOP_PAGES) return null;
      return `export const DESKTOP_PAGE_SCRIPTS = ${JSON.stringify(readDesktopPageScripts(repoRoot))};`;
    },
  };
}

export default defineConfig({
  root: appDir,
  base: "/__app/",
  // A dependency cache for each app port: an app server on another port (another workbench run in
  // this checkout) never optimizes the dependencies again in the folder this one serves them from.
  cacheDir: path.join(
    appDir,
    "node_modules",
    ".vite-workbench",
    String(APP_PORT),
  ),
  clearScreen: false,
  plugins: [
    busyPort(),
    noConfigRestart(),
    workbenchHtml(),
    desktopPages(),
    tanstackRouter({
      autoCodeSplitting: true,
      codeSplittingOptions: routeCodeSplittingOptions,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(appDir, "src"),
    },
  },
  define: {
    __OPENBOT_APP_VERSION__: JSON.stringify(""),
  },
  server: {
    host: "127.0.0.1",
    port: APP_PORT,
    strictPort: true,
    hmr: { clientPort: WORKBENCH_PORT },
    fs: { allow: [repoRoot] },
    // Each app server start runs generate:app-config, which writes this file again. Watched, every
    // other app server of this checkout hot-updated its open frames in the middle of their runs.
    watch: { ignored: ["**/src/lib/generated/application-config.ts"] },
  },
  optimizeDeps: {
    entries: [
      "index.html",
      "src/routes/**/*.tsx",
      "workbench/frameBoot.ts",
      "workbench/scenes/index.ts",
    ],
    include: ["msw", "motion/react"],
  },
});
