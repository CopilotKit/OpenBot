import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileFor,
  isApiCall,
  isClientRoute,
  upstreamWebSocketHeaders,
} from "../serve";

async function probeServingPorts(env: {
  APP_PORT?: string;
  SERVER_PORT?: string;
}) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-serve-ports-"));
  const preload = join(directory, "probe.mjs");
  try {
    // Run the real entry and API handler, stopping both boundaries before any network access.
    // This also exercises privileged/default ports without binding or contacting those services.
    await writeFile(
      preload,
      `globalThis.fetch = async (target) => Response.json({ target });
Bun.serve = (options) => {
  Promise.resolve(options.fetch(new Request("http://localhost/api/port-check"), {}))
    .then((response) => response.json())
    .then(({ target }) => {
      console.log("PORT_PROBE:" + JSON.stringify({ port: options.port, target }));
      process.exit(0);
    }).catch((error) => { console.error(error); process.exit(1); });
};
`,
    );
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--no-env-file",
        "--preload",
        preload,
        "serve.ts",
      ],
      cwd: import.meta.dir.replace(/\/tests$/, ""),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill(), 2_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    } finally {
      clearTimeout(timeout);
      child.kill();
      await child.exited;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("serving port configuration", () => {
  test.each([undefined, "", " \t "])(
    "absent or blank ports use the app and server defaults: %j",
    async (raw) => {
      const result = await probeServingPorts({
        APP_PORT: raw,
        SERVER_PORT: raw,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        'PORT_PROBE:{"port":3010,"target":"http://127.0.0.1:3001/api/port-check"}',
      );
      expect(result.stdout).toContain("OpenBot app on http://127.0.0.1:3010");
    },
  );

  test.each(["1", "65535", " 43123 "])(
    "accepts whole ports including both bounds and surrounding whitespace: %j",
    async (raw) => {
      const result = await probeServingPorts({
        APP_PORT: raw,
        SERVER_PORT: raw,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        `PORT_PROBE:${JSON.stringify({
          port: Number(raw),
          target: `http://127.0.0.1:${Number(raw)}/api/port-check`,
        })}`,
      );
    },
  );

  for (const name of ["APP_PORT", "SERVER_PORT"] as const) {
    test.each(["3010oops", "0", "-1", "65536", "1.5", "1e3"])(
      `${name} refuses invalid ports before serving: %j`,
      async (raw) => {
        const result = await probeServingPorts({ [name]: raw });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain(
          `${name} must be a whole number from 1 to 65535`,
        );
        expect(result.stdout).not.toContain("PORT_PROBE:");
        expect(result.stdout).not.toContain("OpenBot app on");
      },
    );
  }
});

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
    expect(fileFor("/assets/caf%C3%A9%25.js")).toEndWith(
      "/dist/assets/café%.js",
    );
  });

  test.each([
    "/%",
    "/%E0%A4%A",
    "/%FF",
    "/%C0%AF",
    "/%ED%A0%80",
    "/%F4%90%80%80",
    "/assets/bad%.js",
  ])("a malformed encoded path is refused: %s", (pathname) => {
    expect(fileFor(pathname)).toBeNull();
  });

  test("a decoded NUL path is refused before it reaches Bun.file", async () => {
    const proxy = await startProxy(await unusedPort());
    try {
      const response = await fetch(
        `http://127.0.0.1:${proxy.port}/assets/a%00b.js`,
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("not found");
    } finally {
      await proxy.stop();
    }

    expect(fileFor("/assets/a%00b.js")).toBeNull();
  });

  test("only decoded NUL is refused by the invalid-path guard", () => {
    expect(fileFor("/assets/a%1Fb.js")).toEndWith("/dist/assets/ab.js");
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
      const response = await fetch(
        `http://127.0.0.1:${port}/assets/proxy-readiness`,
      );
      if (response.status === 404) return;
    } catch {
      await Bun.sleep(25);
    }
  }
  throw new Error("proxy did not start");
}

async function startProxy(upstreamPort: number) {
  const port = await unusedPort();
  const child = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", "serve.ts"],
    cwd: import.meta.dir.replace(/\/tests$/, ""),
    env: { APP_PORT: String(port), SERVER_PORT: String(upstreamPort) },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await waitForProxy(port);
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  }
  return {
    port,
    async stop() {
      child.kill();
      await child.exited;
    },
  };
}

async function failedHandshake(url: string, headers: HeadersInit = {}) {
  const events: string[] = [];
  const socket = new WebSocket(url, { headers });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("handshake stayed pending")),
        7_000,
      );
      socket.onopen = () => events.push("open");
      socket.onerror = () => events.push("error");
      socket.onclose = () => {
        events.push("close");
        clearTimeout(timeout);
        resolve();
      };
    });
    return events;
  } finally {
    socket.terminate();
  }
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
    const upstream = startAuthenticatedUpstream(upstreamPort);
    const proxy = await startProxy(upstreamPort);
    const proxyPort = proxy.port;

    try {
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

      const unauthorizedEvents = await failedHandshake(
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
      expect(unauthorizedEvents).toEqual(["error", "close"]);
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
      upstream.server.stop(true);
      await proxy.stop();
    }
  });
});

describe("upstream websocket handshake", () => {
  test("an unavailable upstream never opens the downstream", async () => {
    const proxy = await startProxy(await unusedPort());
    try {
      expect(
        await failedHandshake(`ws://127.0.0.1:${proxy.port}/api/events`),
      ).toEqual(["error", "close"]);
    } finally {
      await proxy.stop();
    }
  });

  test("a stalled handshake times out and releases its upstream TCP socket", async () => {
    const sockets = new Set<Socket>();
    let requests = 0;
    const upstream = createServer((socket) => {
      sockets.add(socket);
      socket.on("data", () => requests++);
      socket.on("close", () => sockets.delete(socket));
    });
    const port = await unusedPort();
    await new Promise<void>((resolve) =>
      upstream.listen(port, "127.0.0.1", resolve),
    );
    const proxy = await startProxy(port);
    try {
      const started = Date.now();
      expect(
        await failedHandshake(`ws://127.0.0.1:${proxy.port}/api/events`),
      ).toEqual(["error", "close"]);
      expect(Date.now() - started).toBeLessThan(6_500);
      expect(requests).toBe(1);
      const deadline = Date.now() + 500;
      while (sockets.size && Date.now() < deadline) await Bun.sleep(10);
      expect(sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await proxy.stop();
    }
  }, 9_000);

  test("a delayed upstream keeps welcome frames and the first downstream inputs in order", async () => {
    let upstreamOpenedAt = 0;
    const received: string[] = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request, server) {
        await Bun.sleep(150);
        if (server.upgrade(request)) return;
        return new Response("bad upgrade", { status: 400 });
      },
      websocket: {
        open(ws) {
          upstreamOpenedAt = Date.now();
          ws.send("welcome:one");
          ws.send("welcome:two");
        },
        message(ws, message) {
          received.push(String(message));
          ws.send(`echo:${message}`);
        },
      },
    });
    const proxy = await startProxy(upstream.port!);
    const socket = new WebSocket(
      `ws://127.0.0.1:${proxy.port}/api/events?mode=delayed`,
    );
    try {
      const messages: string[] = [];
      let downstreamOpenedAfterUpstream = false;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("messages did not arrive")),
          2_000,
        );
        socket.onopen = () => {
          downstreamOpenedAfterUpstream = upstreamOpenedAt > 0;
          socket.send("one");
          socket.send("two");
        };
        socket.onmessage = (event) => {
          messages.push(String(event.data));
          if (messages.length === 4) {
            clearTimeout(timeout);
            resolve();
          }
        };
        socket.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("healthy socket failed"));
        };
      });
      expect(downstreamOpenedAfterUpstream).toBe(true);
      expect(messages).toEqual([
        "welcome:one",
        "welcome:two",
        "echo:one",
        "echo:two",
      ]);
      expect(received).toEqual(["one", "two"]);
    } finally {
      socket.terminate();
      upstream.stop(true);
      await proxy.stop();
    }
  });
});
