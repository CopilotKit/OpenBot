// One address in development: the gateway's socket through the dev server.
//
// The server hands a client CopilotKit Intelligence's gateway socket as a path on OpenBot's own
// address, `/api/intelligence/client`, and the page resolves a path against itself. In development
// the page is the Vite dev server's, so that socket arrives here and has to be carried on to the
// server like every other `/api` call. Answered with the app's HTML instead, every conversation in
// a dev stack waits on a socket that never opens.
//
// The real dev server, started the way `bun run dev` starts it, in front of a real WebSocket server
// standing in for OpenBot's. What is pinned is what the browser's Phoenix client depends on: the
// path and query arrive as sent, text stays text and binary stays binary, on both loopbacks.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { reservePort } from "../../tests/support/reserved-port";

const SOCKET = "/api/intelligence/client/websocket?vsn=2.0.0&join_token=jt-123";

const upgrades: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let vite: ReturnType<typeof Bun.spawn>;
let appPort: number;

beforeAll(async () => {
  const serverPort = await reservePort();
  appPort = await reservePort();
  server = Bun.serve({
    port: serverPort,
    hostname: "127.0.0.1",
    fetch(request, bun) {
      const url = new URL(request.url);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        upgrades.push(url.pathname + url.search);
        if (bun.upgrade(request, { data: undefined })) return undefined;
        return new Response("Expected a WebSocket upgrade.", { status: 400 });
      }
      return Response.json({ path: url.pathname });
    },
    websocket: {
      message(ws, message) {
        ws.send(message);
      },
    },
  });
  // As the `dev` script runs it, without the step before it that writes the app's configuration,
  // which a proxy does not read.
  vite = Bun.spawn({
    cmd: [
      process.execPath,
      "--bun",
      "node_modules/vite/bin/vite.js",
      "--port",
      String(appPort),
      "--strictPort",
    ],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      APP_PORT: String(appPort),
      SERVER_PORT: String(serverPort),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const answer = await fetch(`http://127.0.0.1:${appPort}/api/ready`);
      if (answer.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline)
      throw new Error("The dev server never answered.");
    await Bun.sleep(200);
  }
}, 90_000);

afterAll(async () => {
  vite?.kill();
  await vite?.exited;
  server?.stop(true);
});

function throughTheDevServer(host: string, frames: (string | Uint8Array)[]) {
  const socket = new WebSocket(`ws://${host}:${appPort}${SOCKET}`);
  socket.binaryType = "arraybuffer";
  return new Promise<(string | Uint8Array)[]>((resolve, reject) => {
    const received: (string | Uint8Array)[] = [];
    const timer = setTimeout(
      () => reject(new Error(`No answer through ${host}.`)),
      10_000,
    );
    socket.onopen = () => {
      for (const frame of frames) socket.send(frame);
    };
    socket.onmessage = (event) => {
      received.push(
        typeof event.data === "string"
          ? event.data
          : new Uint8Array(event.data as ArrayBuffer),
      );
      if (received.length < frames.length) return;
      clearTimeout(timer);
      socket.close();
      resolve(received);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`The socket through ${host} failed.`));
    };
  });
}

test.each(["127.0.0.1", "[::1]"])(
  "the dev server carries the gateway's socket to the server, from %s",
  async (host) => {
    upgrades.length = 0;
    const join = '["1","1","thread:t-1","phx_join",{}]';
    const binary = new Uint8Array([0, 1, 2, 250, 251]);

    const received = await throughTheDevServer(host, [join, binary]);

    expect(upgrades).toEqual([SOCKET]);
    expect(received[0]).toBe(join);
    expect([...(received[1] as Uint8Array)]).toEqual([...binary]);
  },
  15_000,
);
