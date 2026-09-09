import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  fileFor,
  isApiCall,
  isClientRoute,
  upstreamWebSocketHeaders,
} from "../serve";

/**
 * Serving the built app, which replaced `vite preview`.
 *
 * The failure that made this necessary: `vite preview` under `bun --bun` dies on the first proxied
 * call with `TypeError: socket.destroySoon is not a function`, so the app served its page, exited,
 * and the shell's window went on saying "OpenBot is running" with nothing listening.
 */
describe("what answers a request", () => {
  test("the server answers its own prefix, and nothing near it", () => {
    expect(isApiCall("/api")).toBe(true);
    expect(isApiCall("/api/channels")).toBe(true);
    // Not the app's own routes, and not a path that merely starts with the same letters.
    expect(isApiCall("/apixyz")).toBe(false);
    expect(isApiCall("/channel/api")).toBe(false);
    expect(isApiCall("/")).toBe(false);
  });

  /**
   * A miss under `/assets` is a real 404. Answering index.html there hands a script tag some HTML,
   * which fails in the console rather than in the network panel and reads as a broken app.
   */
  test("a missing built file is not answered with the page", () => {
    expect(isClientRoute("/assets/index-abc123.js")).toBe(false);
    expect(isClientRoute("/favicon.ico")).toBe(false);
  });

  /** Every other miss is the app's own router: /channel/<id> has to load the page. */
  test("a client route is answered with the page", () => {
    expect(isClientRoute("/channel/channel_1ed78a89")).toBe(true);
    expect(isClientRoute("/agents")).toBe(true);
    expect(isClientRoute("/")).toBe(true);
  });
});

describe("which file a path names", () => {
  test("the root and any directory are the page", () => {
    expect(fileFor("/")).toEndWith("/dist/index.html");
    expect(fileFor("/channel/")).toEndWith("/dist/index.html");
  });

  test("a built asset is itself", () => {
    expect(fileFor("/assets/index-abc.js")).toEndWith(
      "/dist/assets/index-abc.js",
    );
  });

  test("an encoded asset remains inside the static directory", () => {
    expect(fileFor("/assets/hello%20world.js")).toEndWith(
      "/dist/assets/hello world.js",
    );
  });

  test("a client route remains available for the router", () => {
    expect(fileFor("/channel/channel_1ed78a89")).toEndWith(
      "/dist/channel/channel_1ed78a89",
    );
  });

  test.each(["/../dist2/file", "/../dist-secret", "/../dist-curation/"])(
    "a prefix sibling is refused: %s",
    (pathname) => {
      expect(fileFor(pathname)).toBeNull();
    },
  );

  test.each([
    "/%2e%2e%2fdist-curation/token.txt",
    "/%2e%2e%2fdist2/file",
    "/assets/%2e%2e%2f%2e%2e%2fdist-secret",
  ])("an encoded separator cannot reach a prefix sibling: %s", (pathname) => {
    expect(fileFor(pathname)).toBeNull();
  });

  /**
   * Nothing outside the directory, whatever the request says. This server has the deployment's
   * `.env` two levels above it, so the traversal guard is not theoretical.
   */
  test("a path that climbs out is refused", () => {
    expect(fileFor("/../.env")).toBeNull();
    expect(fileFor("/../../.env")).toBeNull();
    expect(fileFor("/%2e%2e/%2e%2e/.env")).toBeNull();
    expect(fileFor("/assets/../../.env")).toBeNull();
  });
});

type HeaderSnapshot = {
  authorization: string | null;
  cookie: string | null;
  origin: string | null;
};

async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("server did not receive a TCP port"));
        }
      });
    });
  });
}

function snapshotHeaders(request: Request): HeaderSnapshot {
  return {
    authorization: request.headers.get("authorization"),
    cookie: request.headers.get("cookie"),
    origin: request.headers.get("origin"),
  };
}

function startAuthenticatedUpstream(port: number) {
  const webSocketHandshakes: HeaderSnapshot[] = [];
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request, server) {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const headers = snapshotHeaders(request);
        webSocketHandshakes.push(headers);
        if (headers.cookie !== "openbot_session=valid") {
          return new Response("Sign in first.", { status: 401 });
        }
        if (server.upgrade(request)) return undefined;
      }

      if (new URL(request.url).pathname === "/api/header-check") {
        return Response.json(snapshotHeaders(request));
      }

      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, message) {
        ws.send(`echo:${message}`);
      },
    },
  });

  return { server, webSocketHandshakes };
}

async function waitForProxy(port: number) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/header-check`);
      if (response.ok) return;
    } catch {
      await Bun.sleep(25);
    }
  }
  throw new Error("proxy did not start");
}

async function connectWebSocket(url: string, headers: HeadersInit) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("websocket did not open"));
    }, 1_000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve(socket);
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("websocket failed before opening"));
      },
      { once: true },
    );
  });
}

async function nextSocketMessage(socket: WebSocket) {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("websocket message timed out"));
    }, 1_000);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        resolve(String(event.data));
      },
      { once: true },
    );
  });
}

async function waitForHandshake(
  handshakes: HeaderSnapshot[],
  count: number,
): Promise<HeaderSnapshot> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const handshake = handshakes.at(count - 1);
    if (handshake) return handshake;
    await Bun.sleep(10);
  }
  throw new Error(`upstream saw ${handshakes.length} websocket handshakes`);
}

describe("api proxy", () => {
  test("keeps upstream websocket forwarding to session and origin headers", () => {
    const headers = upstreamWebSocketHeaders(
      new Headers({
        Authorization: "Bearer app-session",
        Connection: "Upgrade",
        Cookie: "openbot_session=valid",
        Host: "127.0.0.1:3010",
        Origin: "http://openbot.local",
        "Sec-WebSocket-Key": "client-generated",
        Upgrade: "websocket",
      }),
    );

    expect(Object.fromEntries(headers)).toEqual({
      authorization: "Bearer app-session",
      cookie: "openbot_session=valid",
      origin: "http://openbot.local",
    });
  });

  test("forwards session headers to authenticated upstream websocket handshakes", async () => {
    const upstreamPort = await unusedPort();
    const proxyPort = await unusedPort();
    const upstream = startAuthenticatedUpstream(upstreamPort);
    const proxy = Bun.spawn({
      cmd: [process.execPath, "serve.ts"],
      cwd: import.meta.dir.replace(/\/tests$/, ""),
      env: {
        ...process.env,
        APP_PORT: String(proxyPort),
        SERVER_PORT: String(upstreamPort),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      await waitForProxy(proxyPort);

      const sessionHeaders = {
        Authorization: "Bearer app-session",
        Cookie: "openbot_session=valid",
        Origin: "http://openbot.local",
      };
      const httpResponse = await fetch(
        `http://127.0.0.1:${proxyPort}/api/header-check`,
        { headers: sessionHeaders },
      );
      expect(await httpResponse.json()).toEqual({
        authorization: "Bearer app-session",
        cookie: "openbot_session=valid",
        origin: "http://openbot.local",
      });

      const unauthorizedSocket = await connectWebSocket(
        `ws://127.0.0.1:${proxyPort}/api/header-check`,
        {
          Authorization: "Bearer app-session",
          Origin: "http://openbot.local",
        },
      );
      const unauthorizedHandshake = await waitForHandshake(
        upstream.webSocketHandshakes,
        1,
      );
      unauthorizedSocket.close();
      expect(unauthorizedHandshake).toEqual({
        authorization: "Bearer app-session",
        cookie: null,
        origin: "http://openbot.local",
      });

      const socket = await connectWebSocket(
        `ws://127.0.0.1:${proxyPort}/api/header-check`,
        sessionHeaders,
      );
      socket.send("ping");
      expect(await nextSocketMessage(socket)).toBe("echo:ping");
      socket.close();
      expect(await waitForHandshake(upstream.webSocketHandshakes, 2)).toEqual({
        authorization: "Bearer app-session",
        cookie: "openbot_session=valid",
        origin: "http://openbot.local",
      });
    } finally {
      proxy.kill();
      upstream.server.stop(true);
      await proxy.exited;
    }
  });
});
