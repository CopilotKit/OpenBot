// Workbench only. The shipped build uses vite.config.ts and never this file.
// Port 3023, behind the workbench server on 3021, which proxies /__app/ to it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { routeCodeSplittingOptions } from "./vite.config";
import { readDesktopPageScripts } from "./workbench/rustScripts";

const appDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(appDir, "..");

const MAIN_TAG = '<script type="module" src="/src/main.tsx"></script>';
const BOOT_TAGS = [
  '<script type="module" src="/workbench/clockBoot.ts"></script>',
  '<script type="module" src="/workbench/frameBoot.ts"></script>',
  MAIN_TAG,
  '<script type="module" src="/workbench/appBoot.ts"></script>',
].join("\n    ");

// The page clock and the fakes boot before the app's own entry, and the preboot runs before the
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
  clearScreen: false,
  plugins: [
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
    port: 3023,
    strictPort: true,
    hmr: { clientPort: Number(process.env.WORKBENCH_PORT || 3021) },
    fs: { allow: [repoRoot] },
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
