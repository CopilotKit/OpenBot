import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { listenPort } from "../shared/listen-port";

/*
 * Announce the server's port to the two runtimes that serve the app through Vite, and to no other.
 *
 * The dev server and the desktop's `vite preview` serve the app on APP_PORT and proxy `/api` to the
 * server, but under bun that proxy cannot carry a WebSocket (oven-sh/bun#24127), so the app's
 * sockets address the server directly on this port. `socketUrl` reads it off `window`.
 *
 * It is deliberately kept OUT of the built HTML. In production the server serves that same HTML on
 * its own origin and answers the upgrade there, so the socket is same-origin; a baked port would
 * point it at a container port an ingress terminating TLS on 443 does not expose, which is how a
 * build-time constant broke the fleet. The dev injection is gated on `ctx.server` so it never runs
 * during `vite build`; `vite preview` serves the static build unchanged and so is handled by its
 * own middleware below.
 */
function announceServerPort(port: number): Plugin {
  const tag = `<script>window.__OPENBOT_WS_PORT__=${JSON.stringify(String(port))};</script>`;
  const inject = (html: string) =>
    html.includes("__OPENBOT_WS_PORT__")
      ? html
      : html.replace("</head>", `    ${tag}\n  </head>`);
  return {
    name: "openbot-announce-server-port",
    transformIndexHtml(html, ctx) {
      return ctx.server ? inject(html) : html;
    },
    configurePreviewServer(server) {
      const indexPath = path.resolve(__dirname, "dist", "index.html");
      server.middlewares.use((request, response, next) => {
        const requestPath = (request.url ?? "/").split("?")[0];
        // Only the SPA entry: a navigation, not an asset with a file extension.
        if (request.method !== "GET" || /\.[^/]+$/.test(requestPath)) {
          return next();
        }
        let html: string;
        try {
          html = readFileSync(indexPath, "utf8");
        } catch {
          return next();
        }
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(inject(html));
      });
    },
  };
}

/*
 * The same address and the same proxy whether this is the dev server or the preview of a build.
 *
 * `preview` is a separate config key with its own defaults, so a deployment that serves the built
 * app rather than the dev server gets no `/api` proxy unless it is repeated here. A desktop install
 * serves the build, and without this every call it makes returns the app's own HTML.
 */
const appPort = listenPort(process.env.APP_PORT, 3010);
if (!appPort.ok) {
  throw new Error(appPort.reason.replace(/^PORT /, "APP_PORT "));
}
const apiPort = listenPort(process.env.SERVER_PORT, 3001);
if (!apiPort.ok) {
  throw new Error(apiPort.reason.replace(/^PORT /, "SERVER_PORT "));
}

const serving = {
  // Both loopbacks, which is what `::` gets you: Node opens a dual-stack socket, so 127.0.0.1 and
  // ::1 both answer. Left to itself Vite binds whichever one this runtime resolves `localhost`
  // to, which is ::1 under Node and 127.0.0.1 under bun, and the other address is then refused.
  // Whoever is told the URL has no way to know which they were given.
  // Empty APP_PORT=/SERVER_PORT= is unset (compose / leftover .env), not NaN — same trap as Bot PORT.
  host: "::",
  port: appPort.port,
  strictPort: true,
  proxy: {
    "/api": {
      target: `http://localhost:${apiPort.port}`,
    },
  },
};

export default defineConfig({
  plugins: [
    announceServerPort(apiPort.port),
    tanstackRouter(),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: serving,
  preview: serving,
});
