// Workbench only. The shipped build uses vite.config.ts and never this file.
// Port 3021 because 3020 belongs to the app.
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, normalizePath, type Plugin } from "vite";

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

export default defineConfig(({ mode }) => ({
  plugins: [react(), workbenchEnv(mode)],
  root: desktopDir,
  clearScreen: false,
  server: { port: 3021, strictPort: true },
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
