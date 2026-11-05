// The Intelligence gateway's client socket, carried through OpenBot's own address.
//
// Where Intelligence runs in the cluster beside OpenBot (the Helm chart's bundled install), the only
// address a person has is OpenBot's: a `kubectl port-forward` to the server. The browser opens the
// gateway's socket itself, so without this every conversation waited on a socket to a Service name
// the browser cannot resolve.
//
// Real paths: the real HTTP server and a real WebSocket server on the far side standing in for the
// gateway's `/client/websocket`, which is plain WebSocket underneath Phoenix. What is pinned is what
// the browser's Phoenix client depends on: the path and query reach the gateway as sent, the join
// sent the instant the browser's socket opens is not lost while the gateway's side is still opening,
// text stays text and binary stays binary, a close code comes back, and OpenBot's session cookie does
// not travel on to Intelligence.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { reservePort } from "../../tests/support/reserved-port";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { DeploymentConfig } from "../src/config";
import { startHttpServer } from "../src/http-server";
import { INTELLIGENCE_CLIENT_SOCKET_PATH } from "../src/intelligence-gateway-proxy";

type Upgrade = {
  path: string;
  search: string;
  cookie: string | null;
};

const upgrades: Upgrade[] = [];
const heard: (string | Uint8Array)[] = [];
let gateway: ReturnType<typeof Bun.serve>;
let gatewayPort: number;

beforeAll(async () => {
  gatewayPort = await reservePort();
  gateway = Bun.serve({
    port: gatewayPort,
    hostname: "127.0.0.1",
    async fetch(request, server) {
      const url = new URL(request.url);
      upgrades.push({
        path: url.pathname,
        search: url.search,
        cookie: request.headers.get("cookie"),
      });
      // Slower to open than the browser is to speak, so the browser's first frame is sent while
      // this side is still connecting: the moment a Phoenix client sends its join.
      await Bun.sleep(300);
      if (server.upgrade(request, { data: undefined })) return undefined;
      return new Response("Expected a WebSocket upgrade.", { status: 400 });
    },
    websocket: {
      message(ws, message) {
        heard.push(message);
        if (message === "close-please") {
          ws.close(4001, "gateway closed it");
          return;
        }
        ws.send(message);
      },
    },
  });
});

afterAll(() => {
  gateway?.stop(true);
});

async function startOpenBot(gatewayProxy: boolean) {
  const port = await reservePort();
  const server = startHttpServer({
    port,
    config: {
      runtime: {
        mode: "intelligence",
        durableHistory: true,
        intelligence: {
          apiUrl: "http://127.0.0.1:1",
          // Written as the chart writes it: the gateway Service's bare address.
          gatewayWsUrl: `ws://127.0.0.1:${gatewayPort}`,
          apiKey: "unused",
          ...(gatewayProxy ? { gatewayProxy: true as const } : {}),
        },
      },
      browserOrigins: [`http://127.0.0.1:${port}`],
    } as unknown as DeploymentConfig,
    // Signed in means carrying the session cookie, as a browser on OpenBot's page does.
    resolveRequestActor: async (request) => {
      if (!request.headers.get("cookie")?.includes("session=signed-in"))
        throw new Error("no session");
      return { id: "ada", name: "Ada", role: "user" };
    },
    agentProfileStore: {} as AgentProfileStore,
    computerGateway: undefined,
    app: { fetch: () => new Response("Not found.", { status: 404 }) },
  });
  return { port, server };
}

/** Open a socket as the browser would, and say everything it heard and how it closed. */
function browserSocket(port: number, frames: (string | Uint8Array)[]) {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}${INTELLIGENCE_CLIENT_SOCKET_PATH}/websocket?vsn=2.0.0&join_token=jt-123`,
    {
      headers: {
        cookie: "session=signed-in",
        origin: `http://127.0.0.1:${port}`,
      },
    } as unknown as string[],
  );
  socket.binaryType = "arraybuffer";
  const received: (string | Uint8Array)[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.onclose = (event) =>
      resolve({ code: event.code, reason: event.reason });
  });
  socket.onopen = () => {
    for (const frame of frames) socket.send(frame);
  };
  socket.onmessage = (event) => {
    received.push(
      typeof event.data === "string"
        ? event.data
        : new Uint8Array(event.data as ArrayBuffer),
    );
  };
  return { socket, received, closed };
}

async function until(check: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

describe("the Intelligence gateway's client socket through OpenBot", () => {
  test("carries the browser's socket to the gateway's /client/websocket, losing nothing sent before the gateway's side opened", async () => {
    const { port, server } = await startOpenBot(true);
    try {
      upgrades.length = 0;
      heard.length = 0;
      const join = '["1","1","thread:t-1","phx_join",{}]';
      const binary = new Uint8Array([0, 1, 2, 250, 251]);
      const { socket, received } = browserSocket(port, [join, binary]);
      await until(() => received.length === 2);

      expect(upgrades).toHaveLength(1);
      expect(upgrades[0]?.path).toBe("/client/websocket");
      expect(upgrades[0]?.search).toBe("?vsn=2.0.0&join_token=jt-123");
      // OpenBot's session is OpenBot's. The gateway authorizes with the join token alone.
      expect(upgrades[0]?.cookie).toBeNull();

      // In order, and in kind: the join as text, the binary frame as the same bytes.
      expect(heard[0]).toBe(join);
      expect(heard[1]).toBeInstanceOf(Uint8Array);
      expect([...(heard[1] as Uint8Array)]).toEqual([...binary]);
      expect(received[0]).toBe(join);
      expect([...(received[1] as Uint8Array)]).toEqual([...binary]);
      socket.close();
    } finally {
      await server.stop(true);
    }
  });

  test("hands the browser the gateway's close code", async () => {
    const { port, server } = await startOpenBot(true);
    try {
      const { closed } = browserSocket(port, ["close-please"]);
      expect((await closed).code).toBe(4001);
    } finally {
      // Not awaited: Bun's `stop` never settles after the server itself closed a socket, which is
      // what this test makes it do. The port is this test's alone.
      void server.stop(true);
    }
  });

  test("refuses a socket with no session, and a page from another site", async () => {
    const { port, server } = await startOpenBot(true);
    try {
      const upgradeHeaders = {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      };
      const url = `http://127.0.0.1:${port}${INTELLIGENCE_CLIENT_SOCKET_PATH}/websocket?vsn=2.0.0`;
      const anonymous = await fetch(url, { headers: upgradeHeaders });
      expect(anonymous.status).toBe(401);
      const foreign = await fetch(url, {
        headers: {
          ...upgradeHeaders,
          cookie: "session=signed-in",
          origin: "https://elsewhere.example",
        },
      });
      expect(foreign.status).toBe(403);
    } finally {
      await server.stop(true);
    }
  });

  test("is not served at all unless the deployment turned it on", async () => {
    const { port, server } = await startOpenBot(false);
    try {
      upgrades.length = 0;
      const response = await fetch(
        `http://127.0.0.1:${port}${INTELLIGENCE_CLIENT_SOCKET_PATH}/websocket?vsn=2.0.0`,
        {
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            cookie: "session=signed-in",
          },
        },
      );
      expect(response.status).toBe(404);
      expect(upgrades).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });
});
