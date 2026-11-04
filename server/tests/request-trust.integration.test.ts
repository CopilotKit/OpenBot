import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { mintRunAssertion } from "../src/agents/callback-token";
import { createApp } from "../src/app";
import { createChannelEventHub } from "../src/channels/events";
import type { ChannelStore } from "../src/channels/routes";
import { createStallGuard } from "../src/channels/stall-guard";
import type { ComputerGateway } from "../src/computer/gateway";
import { type DeploymentConfig, loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { startHttpServer } from "../src/http-server";
import { createRequestActor } from "../src/request-actor";
import type { RoutineRunner } from "../src/routines/runner";
import { testEnvironment } from "./support/environment";

/*
 * Who this server trusts, through the real thing: the app index.ts builds, on the real front door
 * (startHttpServer) on a real port, with the real CopilotKit runtime mounted, and real requests and
 * real WebSocket handshakes carrying the headers a browser, another machine, a rebinding page, a Bot
 * and the worker each send. Only what sits behind the routes is a stand-in: the conversation a Bot
 * turn would run in, the computer a live screen shows, the tool a Bot calls.
 *
 * Every refusal here was an admission on main: a page on any website could drive a single-user
 * OpenBot, anybody on the same network was its administrator, and a name pointed at 127.0.0.1 was
 * same-origin with it.
 */

const AGENT_TOOL_TOKEN = "request-trust-agent-tool-token";
const WORKER_SECRET = "request-trust-worker-secret";
const EVIL = "https://evil.example";
const APP_ORIGIN = "http://127.0.0.1:3010";
const EXTENSION_ORIGIN = `chrome-extension://${RECORDER_EXTENSION_ID}`;
const REBOUND = "rebind.evil.example";
const CROSS_SITE =
  "OpenBot only takes this from its own pages. Open OpenBot and try again there.";
const WRONG_HOST =
  "OpenBot doesn't answer at this address. Open it at localhost or 127.0.0.1 on this computer.";
const OTHER_MACHINE =
  "This OpenBot only answers on the computer it runs on. Open it there, or set up sign-in so other people can use it.";

/** This machine's address on its network: a connection to it arrives from there, as another machine's would. */
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find(
    (entry) =>
      entry !== undefined && !entry.internal && entry.family === "IPv4",
  )?.address;

/** A single-user OpenBot with no sign-in, as `.env.example` and OpenBot Desktop run it. */
function singleUserEnvironment(overrides: Record<string, string | undefined>) {
  return testEnvironment({
    GOOGLE_OAUTH_CLIENT_ID: undefined,
    GOOGLE_OAUTH_CLIENT_SECRET: undefined,
    BETTER_AUTH_SECRET: undefined,
    BETTER_AUTH_URL: undefined,
    INITIAL_ADMIN_EMAILS: undefined,
    OPENBOT_SINGLE_USER: "true",
    TRUSTED_ORIGINS: "http://localhost:3010",
    APP_PORT: "3010",
    AGENT_TOOL_TOKEN,
    WORKER_SHARED_SECRET: WORKER_SECRET,
    AGENT_COMPUTER_URL: "http://127.0.0.1:4100",
    COMPUTER_TOKEN: "request-trust-computer-token",
    ...overrides,
  });
}

type Booted = {
  config: DeploymentConfig;
  base: string;
  port: number;
  turns: string[];
  routineRuns: string[];
  stop(): Promise<void>;
};

const booted: Booted[] = [];
let computer: ReturnType<typeof Bun.serve> | undefined;

/** The live screen's far end: a computer that sends one frame to whoever connects. */
function computerUpstream() {
  computer ??= Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      if (server.upgrade(request, { data: undefined })) return undefined;
      return new Response("computer", { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send("frame");
      },
      message() {},
    },
  });
  return computer;
}

async function boot(
  overrides: Record<string, string | undefined> = {},
): Promise<Booted> {
  const config = loadConfig(singleUserEnvironment(overrides));
  const { resolveRequestActor, identifyUser, identifyActor } =
    createRequestActor({
      singleUser: config.singleUser,
      getSession: async () => null,
      rolesForUser: async () => [],
    });
  const runtime = mountCopilotRuntime(
    config,
    createActorAgentResolver({
      model: { provider: "openai", defaultModel: "unused" },
      loadAgents: async () => [
        {
          id: "general-assistant",
          name: "General Assistant",
          type: "built_in" as const,
          systemPrompt: "Help.",
        },
      ],
      resolveModelApiKey: async () => "synthetic-key",
      stallGuard: createStallGuard({ stallMs: 0 }),
    }),
    identifyUser,
    identifyActor,
  );
  const turns: string[] = [];
  const routineRuns: string[] = [];
  const upstream = computerUpstream();
  const gateway = {
    seatFor: async (botId: string) => ({ botId }),
    locate: async () => `http://127.0.0.1:${upstream.port}`,
    addressOf: (seat: { botId: string }) => seat,
    tokenFor: () => "request-trust-computer-token",
  } as unknown as ComputerGateway;
  // createApp is positional; each dependency is placed at the index of the parameter it fills.
  const args = new Array(createApp.length) as unknown as Parameters<
    typeof createApp
  >;
  args[0] = config;
  args[6] = runtime.handler;
  args[7] = gateway;
  args[10] = {} as ChannelStore;
  args[11] = createChannelEventHub();
  args[21] = {
    run: async (id: string) => {
      routineRuns.push(id);
    },
  } as unknown as RoutineRunner;
  args[28] = async () => ({ text: "called", isError: false });
  args[34] = {
    delivery: {
      authenticated: {
        store: {} as never,
        router: {
          receiveNative: async (_scope: unknown, text: string) => {
            turns.push(text);
            return { accepted: true };
          },
        } as never,
        scopeFor: async (
          owner: string,
          channelId: string,
          agentId: string,
        ) => ({ ownerUserId: owner, channelId, agentId, threadId: "thread-1" }),
        listConversations: async () => ({ channels: [], nextCursor: null }),
        history: async () => [],
      },
      webhooks: {
        router: {} as never,
        store: {} as never,
        scopeFor: async () => null,
      },
    },
  } as never;
  const app = createApp(...args);
  const server = startHttpServer({
    port: 0,
    config,
    resolveRequestActor,
    agentProfileStore: {
      get: async () => ({ visibility: "public", ownerUserId: null }),
    } as never,
    computerGateway: gateway,
    app,
  }) as unknown as { port: number; stop(close?: boolean): Promise<void> };
  const handle: Booted = {
    config,
    port: server.port,
    base: `http://127.0.0.1:${server.port}`,
    turns,
    routineRuns,
    stop: () => server.stop(true),
  };
  booted.push(handle);
  return handle;
}

afterAll(async () => {
  for (const handle of booted) await handle.stop();
  await computer?.stop(true);
});

/**
 * A WebSocket handshake, with the headers the caller chooses: whether it opened, and, for a socket that
 * speaks first, its first message.
 */
function handshake(
  url: string,
  headers: Record<string, string>,
  options: { firstMessage?: boolean } = {},
): Promise<{ opened: boolean; first?: string }> {
  return new Promise((resolve) => {
    const socket = new (
      WebSocket as unknown as {
        new (
          url: string,
          options: { headers: Record<string, string> },
        ): WebSocket;
      }
    )(url, { headers });
    let opened = false;
    const done = (answer: { opened: boolean; first?: string }) => {
      clearTimeout(timer);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
      resolve(answer);
    };
    const timer = setTimeout(() => done({ opened }), 3_000);
    socket.onopen = () => {
      opened = true;
      if (!options.firstMessage) done({ opened });
    };
    socket.onmessage = (event) => done({ opened, first: String(event.data) });
    socket.onerror = () => done({ opened });
    socket.onclose = () => done({ opened });
  });
}

/** Only a private address: the suite's network guard lets a raw socket reach one, and nothing else beyond loopback. */
const lanIsPrivate =
  lanAddress !== undefined &&
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(lanAddress);

/**
 * One HTTP/1.1 exchange over a plain socket, from this machine to its own network address, so the server
 * sees a peer that is not loopback, as it does for another machine on the network.
 *
 * A socket rather than `fetch` because the suite's network guard (server/scripts/test-network-guard.ts)
 * keeps `fetch` and `WebSocket` on loopback, and lets a raw socket reach a private address, which this
 * is. The request is written out as any client writes it. `address` sends it to another of this
 * machine's addresses instead, for an answer `fetch` cannot read, such as a refused WebSocket handshake.
 */
function overTheNetwork(input: {
  port: number;
  address?: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  const address = input.address ?? (lanAddress as string);
  const headers: Record<string, string> = {
    host: `${address}:${input.port}`,
    connection: "close",
    ...(input.body === undefined
      ? {}
      : { "content-length": String(Buffer.byteLength(input.body)) }),
    ...input.headers,
  };
  const head = [
    `${input.method ?? "GET"} ${input.path} HTTP/1.1`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ].join("\r\n");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let finished = false;
    const socket = connect({ host: address, port: input.port }, () => {
      socket.write(`${head}\r\n\r\n${input.body ?? ""}`);
    });
    const finish = () => {
      if (finished) return;
      finished = true;
      const text = Buffer.concat(chunks).toString("utf8");
      const [top = "", ...rest] = text.split("\r\n\r\n");
      const raw = rest.join("\r\n\r\n");
      resolve({
        status: Number(top.split(" ")[1]),
        body: /transfer-encoding:\s*chunked/i.test(top) ? dechunk(raw) : raw,
      });
    };
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      const headEnd = text.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      // An upgrade answered 101 stays open, and so does a refused one: the client asked to keep the
      // connection. A whole answer is the head and as many bytes as it says.
      const length = /content-length:\s*(\d+)/i.exec(text.slice(0, headEnd));
      if (
        text.startsWith("HTTP/1.1 101") ||
        (length?.[1] !== undefined &&
          Buffer.byteLength(text.slice(headEnd + 4)) >= Number(length[1]))
      ) {
        socket.destroy();
        finish();
      }
    });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", reject);
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error(`no answer from ${address}:${input.port}`));
    });
  });
}

function dechunk(raw: string): string {
  let rest = raw;
  let out = "";
  for (;;) {
    const line = rest.indexOf("\r\n");
    const size = Number.parseInt(rest.slice(0, line), 16);
    if (!size) return out;
    out += rest.slice(line + 2, line + 2 + size);
    rest = rest.slice(line + 2 + size + 2);
  }
}

/** The headers of a WebSocket handshake, as any client sends them. */
const UPGRADE = {
  upgrade: "websocket",
  connection: "Upgrade",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  "sec-websocket-version": "13",
};

const turn = (text: string) =>
  JSON.stringify({ agentId: "general-assistant", text });

let local: Booted;
beforeAll(async () => {
  local = await boot();
});
// Each test reads only the turns and routine runs it caused.
beforeEach(() => {
  local.turns.length = 0;
  local.routineRuns.length = 0;
});

describe("a page on another website", () => {
  test("cannot read the runtime: no CORS for a foreign origin, on an answer or a preflight", async () => {
    const info = await fetch(`${local.base}/api/copilotkit/info`, {
      headers: { origin: EVIL, "sec-fetch-site": "cross-site" },
    });
    expect(info.headers.get("access-control-allow-origin")).toBeNull();

    const preflight = await fetch(
      `${local.base}/api/copilotkit/agent/general-assistant/run`,
      {
        method: "OPTIONS",
        headers: {
          origin: EVIL,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      },
    );
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("cannot start a Bot turn with a text/plain post, which a browser sends without asking first", async () => {
    const posted = await fetch(
      `${local.base}/api/delivery/conversations/channel-1/messages`,
      {
        method: "POST",
        headers: {
          origin: EVIL,
          "sec-fetch-site": "cross-site",
          "content-type": "text/plain",
        },
        body: turn("send it"),
      },
    );
    expect(posted.status).toBe(403);
    expect(await posted.json()).toEqual({ error: CROSS_SITE });
    expect(local.turns).toEqual([]);
  });

  test("is refused with no Origin when the browser still says the request was another site's", async () => {
    const posted = await fetch(
      `${local.base}/api/delivery/conversations/channel-1/messages`,
      {
        method: "POST",
        headers: {
          "sec-fetch-site": "cross-site",
          "content-type": "text/plain",
        },
        body: turn("send it"),
      },
    );
    expect(posted.status).toBe(403);
    expect(local.turns).toEqual([]);
  });

  test("cannot open the channel events socket", async () => {
    const opened = await handshake(
      `ws://127.0.0.1:${local.port}/api/channels/events`,
      { origin: EVIL },
    );
    expect(opened.opened).toBe(false);
  });

  test("cannot open a Bot's live screen", async () => {
    const opened = await handshake(
      `ws://127.0.0.1:${local.port}/api/computers/general-assistant/stream`,
      { origin: EVIL },
      { firstMessage: true },
    );
    expect(opened.opened).toBe(false);
  });
});

describe("OpenBot's own callers", () => {
  test("the app, through the proxy that serves it, starts a turn and reads the runtime", async () => {
    // app/serve.ts and Vite pass the browser's Host on, so a proxied call is same-origin.
    const posted = await fetch(
      `${local.base}/api/delivery/conversations/channel-1/messages`,
      {
        method: "POST",
        headers: {
          origin: APP_ORIGIN,
          host: "127.0.0.1:3010",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: turn("hello"),
      },
    );
    expect(posted.status).toBe(202);
    expect(local.turns).toEqual(["hello"]);
    local.turns.length = 0;

    const info = await fetch(`${local.base}/api/copilotkit/info`, {
      headers: { origin: APP_ORIGIN, host: "127.0.0.1:3010" },
    });
    expect(info.status).toBe(200);
  });

  test("the app's sockets, which reach this port from the app's origin, open", async () => {
    const events = await handshake(
      `ws://127.0.0.1:${local.port}/api/channels/events`,
      { origin: "http://localhost:3010" },
    );
    expect(events.opened).toBe(true);
    const screen = await handshake(
      `ws://127.0.0.1:${local.port}/api/computers/general-assistant/stream`,
      { origin: APP_ORIGIN },
      { firstMessage: true },
    );
    expect(screen).toEqual({ opened: true, first: "frame" });
  });

  test("the Recorder extension posts, and the runtime answers its preflight", async () => {
    const posted = await fetch(
      `${local.base}/api/delivery/conversations/channel-1/messages`,
      {
        method: "POST",
        headers: {
          origin: EXTENSION_ORIGIN,
          "sec-fetch-site": "none",
          "content-type": "application/json",
        },
        body: turn("from the Recorder"),
      },
    );
    expect(posted.status).toBe(202);
    local.turns.length = 0;

    const preflight = await fetch(
      `${local.base}/api/copilotkit/trajectory/00000000-0000-4000-8000-000000000000/connect`,
      {
        method: "OPTIONS",
        headers: {
          origin: EXTENSION_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,content-type",
        },
      },
    );
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      EXTENSION_ORIGIN,
    );
  });

  test("a client that is not a browser, with neither Origin nor Sec-Fetch-Site, still posts", async () => {
    const posted = await fetch(
      `${local.base}/api/delivery/conversations/channel-1/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: turn("from a CLI"),
      },
    );
    expect(posted.status).toBe(202);
    local.turns.length = 0;
  });
});

describe("a page whose name was pointed at this machine (DNS rebinding)", () => {
  test("is not the single-user administrator, on any route that admits it", async () => {
    const host = `${REBOUND}:${local.port}`;
    // Same-origin with itself, so its Origin is its own name, and its peer is loopback.
    const me = await fetch(`${local.base}/api/me`, {
      headers: { host, "sec-fetch-site": "same-origin" },
    });
    expect(me.status).toBe(403);
    expect(await me.json()).toEqual({ error: WRONG_HOST });

    const posted = await fetch(
      `${local.base}/api/delivery/conversations/channel-1/messages`,
      {
        method: "POST",
        headers: {
          host,
          origin: `http://${host}`,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: turn("rebound"),
      },
    );
    expect(posted.status).toBe(403);
    expect(local.turns).toEqual([]);

    const info = await fetch(`${local.base}/api/copilotkit/info`, {
      headers: { host },
    });
    expect(info.status).toBe(403);
    const single = await fetch(`${local.base}/api/copilotkit`, {
      method: "POST",
      headers: { host, "content-type": "application/json" },
      body: JSON.stringify({ method: "info" }),
    });
    expect(single.status).toBe(403);

    const events = await handshake(
      `ws://127.0.0.1:${local.port}/api/channels/events`,
      { host, origin: `http://${host}` },
    );
    expect(events.opened).toBe(false);
    const screen = await handshake(
      `ws://127.0.0.1:${local.port}/api/computers/general-assistant/stream`,
      { host, origin: `http://${host}` },
      { firstMessage: true },
    );
    expect(screen.opened).toBe(false);
  });

  test("this machine's own names are still the administrator", async () => {
    for (const host of [
      `localhost:${local.port}`,
      `[::1]:${local.port}`,
      `127.0.0.1:${local.port}`,
    ]) {
      const me = await fetch(`${local.base}/api/me`, { headers: { host } });
      expect(me.status).toBe(200);
      expect(((await me.json()) as { user: { id: string } }).user.id).toBe(
        "dev-local-user",
      );
    }
  });
});

describe("the app opened at an address on the network, the only one configured", () => {
  /*
   * `OPENBOT_PUBLIC_URL` alone, as somebody making a single-user OpenBot reachable on their network
   * writes it. Another machine opens the app on the same host at the app's port, and the app opens its
   * sockets straight to this server's port from there, so `Origin` names the app's port and `Host` this
   * server's. The address is written out rather than read from this machine: what is asked is the
   * configuration, and the server sees the `Host` it is sent whichever interface the request came in on.
   */
  const ADDRESS = "192.168.1.10";
  const HOST = `${ADDRESS}:3001`;
  const APP = `http://${ADDRESS}:3010`;
  let lan: Booted;
  beforeAll(async () => {
    lan = await boot({
      OPENBOT_PUBLIC_URL: `http://${HOST}`,
      TRUSTED_ORIGINS: undefined,
    });
  });
  beforeEach(() => {
    lan.turns.length = 0;
  });

  const post = (origin: string) =>
    fetch(`${lan.base}/api/delivery/conversations/channel-1/messages`, {
      method: "POST",
      headers: {
        host: HOST,
        origin,
        "sec-fetch-site": "same-site",
        "content-type": "application/json",
      },
      body: turn(`from ${origin}`),
    });

  test("the app's sockets open, and a change it posts to this port goes through", async () => {
    const events = await handshake(
      `ws://127.0.0.1:${lan.port}/api/channels/events`,
      { host: HOST, origin: APP },
    );
    expect(events.opened).toBe(true);
    const screen = await handshake(
      `ws://127.0.0.1:${lan.port}/api/computers/general-assistant/stream`,
      { host: HOST, origin: APP },
      { firstMessage: true },
    );
    expect(screen).toEqual({ opened: true, first: "frame" });

    const posted = await post(APP);
    expect(posted.status).toBe(202);
    expect(lan.turns).toEqual([`from ${APP}`]);
  });

  test.each([
    ["another port on that host", `http://${ADDRESS}:4444`],
    ["another address on the network", "http://192.168.1.11:3010"],
    ["a name nobody configured, on the app's port", "http://evil.example:3010"],
    ["a page that is nobody's", "null"],
  ])(
    "%s is still another site: no socket, no change",
    async (_name, origin) => {
      for (const path of [
        "/api/channels/events",
        "/api/computers/general-assistant/stream",
      ]) {
        const socket = await overTheNetwork({
          address: "127.0.0.1",
          port: lan.port,
          path,
          headers: { ...UPGRADE, host: HOST, origin },
        });
        expect(socket.status).toBe(403);
        expect(JSON.parse(socket.body)).toEqual({ error: CROSS_SITE });
      }

      const posted = await post(origin);
      expect(posted.status).toBe(403);
      expect(await posted.json()).toEqual({ error: CROSS_SITE });
      expect(lan.turns).toEqual([]);
    },
  );

  test("a client that is not a browser still posts, with no Origin", async () => {
    const posted = await fetch(
      `${lan.base}/api/delivery/conversations/channel-1/messages`,
      {
        method: "POST",
        headers: { host: HOST, "content-type": "application/json" },
        body: turn("from a CLI"),
      },
    );
    expect(posted.status).toBe(202);
    expect(lan.turns).toEqual(["from a CLI"]);
  });
});

describe.skipIf(!lanIsPrivate)("another machine on the network", () => {
  test("is not the administrator of an OpenBot running on somebody's own machine", async () => {
    const me = await overTheNetwork({ port: local.port, path: "/api/me" });
    expect(me.status).toBe(403);
    expect(JSON.parse(me.body)).toEqual({ error: OTHER_MACHINE });
    const posted = await overTheNetwork({
      port: local.port,
      method: "POST",
      path: "/api/delivery/conversations/channel-1/messages",
      headers: { "content-type": "application/json" },
      body: turn("lan"),
    });
    expect(posted.status).toBe(403);
    expect(local.turns).toEqual([]);
    const info = await overTheNetwork({
      port: local.port,
      path: "/api/copilotkit/info",
    });
    expect(info.status).toBe(403);
    for (const path of [
      "/api/computers/general-assistant/stream",
      "/api/channels/events",
    ]) {
      const socket = await overTheNetwork({
        port: local.port,
        path,
        headers: UPGRADE,
      });
      expect(socket.status).toBe(403);
    }
  });

  test("still reaches the routes containers call back on, which prove themselves with their own secrets", async () => {
    // The worker in Compose calls `http://server:3001`; a Bot calls `host.docker.internal`.
    const routine = await overTheNetwork({
      port: local.port,
      method: "POST",
      path: "/internal/routines/run",
      headers: {
        host: "server:3001",
        authorization: `Bearer ${WORKER_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ routineRunId: "run-1" }),
    });
    expect(routine.status).toBe(202);
    expect(local.routineRuns).toEqual(["run-1"]);

    const tool = await overTheNetwork({
      port: local.port,
      method: "POST",
      path: "/api/agent-tools/call",
      headers: {
        host: `host.docker.internal:${local.port}`,
        "content-type": "application/json",
        "x-openbot-agent-token": AGENT_TOOL_TOKEN,
      },
      body: JSON.stringify({
        name: "mcp__linear__LINEAR_CREATE_ISSUE",
        args: {},
        run: mintRunAssertion(
          {
            botId: "general-assistant",
            actorId: "dev-local-user",
            runId: "run-1",
          },
          local.config.keyEncryptionKey,
        ),
      }),
    });
    expect(tool.status).toBe(200);
    expect(JSON.parse(tool.body)).toEqual({ text: "called", isError: false });
  });

  test("is the administrator where the operator named an address on the network", async () => {
    const shared = await boot({
      OPENBOT_APP_URL: `http://${lanAddress}:3010`,
    });
    const posted = await overTheNetwork({
      port: shared.port,
      method: "POST",
      path: "/api/delivery/conversations/channel-1/messages",
      headers: { "content-type": "application/json" },
      body: turn("named"),
    });
    expect(posted.status).toBe(202);
    expect(shared.turns).toEqual(["named"]);
  });

  test("is the administrator of an OpenBot in a container, where every caller comes through the engine", async () => {
    const contained = await boot({ OPENBOT_IN_CONTAINER: "true" });
    const posted = await overTheNetwork({
      port: contained.port,
      method: "POST",
      path: "/api/delivery/conversations/channel-1/messages",
      headers: { "content-type": "application/json" },
      body: turn("contained"),
    });
    expect(posted.status).toBe(202);
    expect(contained.turns).toEqual(["contained"]);
    // A name still cannot stand in for this machine there.
    const rebound = await fetch(`http://127.0.0.1:${contained.port}/api/me`, {
      headers: { host: `${REBOUND}:${contained.port}` },
    });
    expect(rebound.status).toBe(403);
  });
});
