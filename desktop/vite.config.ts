import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { buildChannel, releaseBuildEnv } from "./scripts/release-build";

// 3020 so a running deployment's app (3010) and API (3001) are untouched while the shell is
// developed against them.
export default defineConfig(({ command }) => {
  // A release or candidate installer's window is built with the release build config. Vite reads
  // the environment's VITE_ values after this file, so they reach `import.meta.env`.
  if (command === "build") {
    Object.assign(
      process.env,
      releaseBuildEnv(
        buildChannel(
          fileURLToPath(new URL("./build-version.json", import.meta.url)),
        ),
        process.env,
      ),
    );
  }
  return {
    plugins: [react()],
    clearScreen: false,
    server: { port: 3020, strictPort: true },
    build: { outDir: "dist", emptyOutDir: true },
  };
});
