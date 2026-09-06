import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/*
 * The same address and the same proxy whether this is the dev server or the preview of a build.
 *
 * `preview` is a separate config key with its own defaults, so a deployment that serves the built
 * app rather than the dev server gets no `/api` proxy unless it is repeated here. A desktop install
 * serves the build, and without this every call it makes returns the app's own HTML.
 */
const serving = {
  // Both loopbacks, which is what `::` gets you: Node opens a dual-stack socket, so 127.0.0.1 and
  // ::1 both answer. Left to itself Vite binds whichever one this runtime resolves `localhost`
  // to, which is ::1 under Node and 127.0.0.1 under bun, and the other address is then refused.
  // Whoever is told the URL has no way to know which they were given.
  host: "::",
  port: Number.parseInt(process.env.APP_PORT ?? "3010", 10),
  strictPort: true,
  proxy: {
    // `ws: true` is required for the live screen. Without it Vite answers the upgrade request with
    // the app's HTML and the socket fails with an opaque error that looks like a server problem.
    "/api": {
      target: `http://localhost:${process.env.SERVER_PORT ?? "3001"}`,
      ws: true,
    },
  },
};

export default defineConfig({
  plugins: [tanstackRouter(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: serving,
  preview: serving,
});
