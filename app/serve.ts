/**
 * Serve the built app, and pass its API calls to the server.
 *
 * NOT VITE. `vite preview` was doing this, run through `bun --bun` so that a machine with bun and
 * no Node could start it at all, and the combination is broken in a way that looks like the whole
 * product failing: Vite's proxy calls `socket.destroySoon()` when an upstream response ends, bun's
 * sockets do not implement it, and the process dies with `TypeError: socket.destroySoon is not a
 * function` on the FIRST call the app makes. So the app served its page, died, and the shell's
 * window went on saying "OpenBot is running" with nothing on the port. Measured on a real install.
 *
 * A development server was never the right thing to run in an installed application, which is what
 * the shell's own comment about this process already said. This serves a directory and forwards one
 * prefix, needs no Node, and has nothing in it that a dev server needs and an install does not.
 */

import { file } from "bun";
import { join, normalize } from "node:path";

const DIST = join(import.meta.dir, "dist");
const PORT = Number.parseInt(process.env.APP_PORT ?? "3010", 10);
const SERVER = `http://127.0.0.1:${process.env.SERVER_PORT ?? "3001"}`;

/**
 * Which file answers a path, or `null` when the app's own router should.
 *
 * Anything under `/assets` is a built file and a miss there is a genuine 404: answering index.html
 * would hand a script tag some HTML and fail in the console instead of in the network panel. Every
 * other miss is a client route (`/channel/...`), which is index.html.
 *
 * Pure, and tested, because the traversal guard lives here: a path is normalised and then checked
 * to be inside the directory, so `/../.env` cannot be served.
 */
export function fileFor(pathname: string): string | null {
  const wanted = normalize(join(DIST, decodeURIComponent(pathname)));
  if (!wanted.startsWith(DIST)) return null;
  if (wanted === DIST || pathname.endsWith("/"))
    return join(DIST, "index.html");
  return wanted;
}

/** Whether the app's router should answer instead of the file system. */
export function isClientRoute(pathname: string): boolean {
  return !pathname.startsWith("/assets/") && !pathname.includes(".");
}

/** Whether this is a call for the server rather than the app. */
export function isApiCall(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

if (import.meta.main) {
  Bun.serve({
    port: PORT,
    // Both loopbacks, which is what `::` gets you: a dual-stack socket answers on 127.0.0.1 and
    // ::1 alike. Bound to one, whoever is told the URL has no way to know which they were given.
    hostname: "::",
    // `ws: true` on the old proxy was required for the live screen, so the upgrade is forwarded
    // rather than answered with the app's HTML, which failed with an opaque socket error.
    websocket: {
      open(ws) {
        const upstream = ws.data as { upstream: WebSocket; queue: unknown[] };
        upstream.upstream.addEventListener("message", (event) => {
          ws.send(event.data as string | Uint8Array);
        });
        upstream.upstream.addEventListener("close", () => ws.close());
      },
      message(ws, message) {
        const { upstream } = ws.data as { upstream: WebSocket };
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(message);
        } else {
          upstream.addEventListener("open", () => upstream.send(message), {
            once: true,
          });
        }
      },
      close(ws) {
        const { upstream } = ws.data as { upstream: WebSocket };
        upstream.close();
      },
    },
    async fetch(request, server) {
      const url = new URL(request.url);

      if (isApiCall(url.pathname)) {
        const target = SERVER + url.pathname + url.search;
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const upstream = new WebSocket(target.replace(/^http/, "ws"));
          if (server.upgrade(request, { data: { upstream } })) return undefined;
          upstream.close();
          return new Response("expected a websocket upgrade", { status: 400 });
        }
        // The body is streamed rather than buffered, and redirects are left to the caller so a
        // 302 from the server is not silently followed to a different origin.
        return fetch(target, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: "manual",
          // @ts-expect-error duplex is required by fetch for a streamed body and is not yet typed.
          duplex: "half",
        });
      }

      const wanted = fileFor(url.pathname);
      if (!wanted) return new Response("not found", { status: 404 });

      const found = file(wanted);
      if (await found.exists()) return new Response(found);
      if (isClientRoute(url.pathname)) {
        return new Response(file(join(DIST, "index.html")));
      }
      return new Response("not found", { status: 404 });
    },
  });

  console.log(
    `OpenBot app on http://127.0.0.1:${PORT} and http://[::1]:${PORT}`,
  );
}
