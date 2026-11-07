import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/client";
import type { MiddlewareHandler } from "hono";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createAgentFetch, onThisMachine } from "../src/agents/endpoint";
import { createAgentRoutes } from "../src/agents/routes";
import type { AppVariables } from "../src/auth/guards";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime, registeredAgentFromRow } from "../src/copilot";
import { testEnvironment } from "./support/environment";

/**
 * An agent a person runs on their own machine, registered at its loopback address.
 *
 * OpenBot Desktop runs this server in a container, where `127.0.0.1` is the container. A person who
 * registered `http://127.0.0.1:8765/ag-ui` was told "This server could not reach that address",
 * while `http://host.docker.internal:8765/ag-ui` worked. The Desktop now tells the server the name
 * its container reaches the machine by (`OPENBOT_THIS_MACHINE_HOST`), and a loopback address is
 * dialled through it.
 *
 * A test process is not in a container, so the translation is proved by where the request lands.
 * The agent below listens on `127.0.0.1` alone, and the Bot is registered at `127.0.0.2`, also
 * loopback, where nothing listens (macOS has only `127.0.0.1` on `lo0`; Linux routes all of
 * `127/8` to `lo` but a socket bound to `127.0.0.1` does not answer `127.0.0.2`). With the setting
 * naming `127.0.0.1`, the request can only arrive if the server dialled that name instead of the
 * address as typed, and the agent records the `Host` it was dialled at to say so. A second check
 * points the setting at a name that resolves nowhere and registers the agent's real address: the
 * request then fails, which proves the literal `127.0.0.1` a person types is the one moved.
 */

const SETTING = "OPENBOT_THIS_MACHINE_HOST";

/** The `Host` each request to the agent arrived with. */
const hosts: string[] = [];
/** AG-UI events the runner delivered to the platform, so a run can be awaited to its end. */
const delivered: { runId?: string; type?: string }[] = [];

let agent: ReturnType<typeof Bun.serve>;
let platform: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  agent = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      hosts.push(request.headers.get("host") ?? "");
      const input = (await request.json()) as RunAgentInput;
      const events = [
        { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
        { type: "TEXT_MESSAGE_START", messageId: "reply", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "reply", delta: "Here." },
        { type: "TEXT_MESSAGE_END", messageId: "reply" },
        { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  // Intelligence, as small as a run needs: the thread, its lock, and the runner's channel, every
  // push acknowledged. The same fake copilot-forwarded-headers.test.ts drives a remote run with.
  type Frame = [
    string | null,
    string | null,
    string,
    string,
    Record<string, unknown>,
  ];
  platform = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/runner/websocket") {
        return server.upgrade(request, {
          data: undefined,
          headers: { "Sec-WebSocket-Protocol": "phoenix" },
        })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      const [, api, threads, threadId, rest] = url.pathname.split("/");
      if (api === "api" && threads === "threads" && threadId) {
        if (rest === undefined && request.method === "GET")
          return Response.json({ thread: { id: threadId, name: "Mine" } });
        if (rest === "messages" && request.method === "GET")
          return Response.json({ messages: [] });
        if (rest === "lock" && request.method === "POST") {
          const body = (await request.json()) as { runId: string };
          return Response.json({
            threadId,
            runId: body.runId,
            joinToken: "join-token",
            ttlSeconds: 20,
          });
        }
        if (rest === "lock" && request.method === "PATCH")
          return Response.json({ ttlSeconds: 20 });
        if (rest === "lock" && request.method === "DELETE")
          return new Response(null, { status: 204 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const [joinRef, ref, topic, event, payload] = JSON.parse(
          String(message),
        ) as Frame;
        if (event === "event") delivered.push(payload);
        if (event === "events")
          delivered.push(...(payload.events as typeof delivered));
        socket.send(
          JSON.stringify([
            joinRef,
            ref,
            topic,
            "phx_reply",
            { status: "ok", response: {} },
          ]),
        );
      },
    },
  });
});

afterAll(() => {
  agent.stop(true);
  platform.stop(true);
});

/** The deployment's configuration, with or without the Desktop's setting. */
function configWith(thisMachineHost: string | undefined) {
  return loadConfig(
    testEnvironment({
      INTELLIGENCE_API_URL: `http://127.0.0.1:${platform.port}`,
      INTELLIGENCE_GATEWAY_WS_URL: `ws://127.0.0.1:${platform.port}`,
      ...(thisMachineHost ? { [SETTING]: thisMachineHost } : {}),
    }),
  );
}

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", { id: "person", email: "p@openbot.test", role: "user" });
  await next();
};

/** POST /test-connection, wired from configuration the way app.ts wires it, on a laptop. */
async function testConnection(
  thisMachineHost: string | undefined,
  endpoint: string,
) {
  const config = configWith(thisMachineHost);
  const routes = createAgentRoutes(
    {} as never,
    requireUser,
    true,
    undefined,
    new Set(),
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    config.thisMachineHost
      ? { thisMachineHost: config.thisMachineHost }
      : undefined,
  );
  const response = await routes.request("http://openbot.test/test-connection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
  return (await response.json()) as { ok: boolean; reason?: string };
}

describe("testing an agent on the person's own machine", () => {
  test("with the setting, a loopback address is dialled through the name it gives", async () => {
    hosts.length = 0;
    const result = await testConnection(
      "127.0.0.1",
      `http://127.0.0.2:${agent.port}/ag-ui`,
    );
    expect(result).toMatchObject({ ok: true });
    expect(hosts).toEqual([`127.0.0.1:${agent.port}`]);
  });

  test("the address the person typed is the one moved", async () => {
    // Their agent really is at this address, and the setting names somewhere that resolves
    // nowhere, so reaching it would mean the address went out as typed.
    hosts.length = 0;
    const result = await testConnection(
      "openbot-this-machine.invalid",
      `http://127.0.0.1:${agent.port}/ag-ui`,
    );
    expect(result.ok).toBe(false);
    expect(hosts).toEqual([]);
  });

  test("without the setting, the address is dialled as written", async () => {
    // A host server (scripts/start.sh) or a hosted deployment, where loopback is this machine.
    hosts.length = 0;
    const result = await testConnection(
      undefined,
      `http://127.0.0.1:${agent.port}/ag-ui`,
    );
    expect(result).toMatchObject({ ok: true });
    expect(hosts).toEqual([`127.0.0.1:${agent.port}`]);
  });

  test("the metadata address stays refused with the setting", async () => {
    const result = await testConnection(
      "127.0.0.1",
      "http://169.254.169.254/latest/meta-data/",
    );
    expect(result.ok).toBe(false);

    // Nor can the setting itself turn an allowed loopback address into it.
    hosts.length = 0;
    const moved = await testConnection(
      "169.254.169.254",
      `http://127.0.0.1:${agent.port}/ag-ui`,
    );
    expect(moved.ok).toBe(false);
    expect(moved.reason).toContain("may not live there");
    expect(hosts).toEqual([]);
  });
});

describe("running a Bot whose agent is on the person's own machine", () => {
  /** A run through the runtime, dialled with the fetch index.ts builds from configuration. */
  async function run(thisMachineHost: string | undefined, endpoint: string) {
    const config = configWith(thisMachineHost);
    const bot = registeredAgentFromRow({
      id: "mine",
      name: "Mine",
      type: "remote_ag_ui",
      configuration: { endpoint },
      title: "My own agent",
      roleDescription: "Answer.",
    });
    if (!bot) throw new Error("the Bot did not parse");
    const person = { id: "person", name: "Person" };
    const runtime = mountCopilotRuntime(
      config,
      createActorAgentResolver({
        model: { provider: "openai", defaultModel: "unused" },
        loadAgents: async () => [bot],
        resolveModelApiKey: async () => null,
        agentFetch: createAgentFetch({
          allowPrivateHosts: true,
          ...(config.thisMachineHost
            ? { thisMachineHost: config.thisMachineHost }
            : {}),
        }),
      }),
      async () => person,
      async () => ({ id: person.id, role: "user" }),
    );
    const runId = `run-${crypto.randomUUID()}`;
    const response = await runtime.handler.fetch(
      new Request("http://127.0.0.1/api/copilotkit/agent/mine/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: `thread-${runId}`,
          runId,
          state: {},
          messages: [{ id: `ask-${runId}`, role: "user", content: "Hello?" }],
          tools: [],
          context: [],
          forwardedProps: {},
        } satisfies RunAgentInput),
      }),
    );
    expect(response.status).toBe(200);
    const deadline = Date.now() + 8_000;
    while (
      !delivered.some(
        (event) => event.runId === runId && event.type === "RUN_FINISHED",
      )
    ) {
      if (Date.now() > deadline) throw new Error("the run never finished");
      await Bun.sleep(10);
    }
  }

  test("with the setting, the run reaches the agent through the name it gives", async () => {
    hosts.length = 0;
    await run("127.0.0.1", `http://127.0.0.2:${agent.port}/ag-ui`);
    expect(hosts).toEqual([`127.0.0.1:${agent.port}`]);
  }, 15_000);

  test("without the setting, the run dials the address as written", async () => {
    hosts.length = 0;
    await run(undefined, `http://127.0.0.1:${agent.port}/ag-ui`);
    expect(hosts).toEqual([`127.0.0.1:${agent.port}`]);
  }, 15_000);
});

/** The rule itself, on the addresses people actually type. */
test("only a loopback host is moved, and only when the setting is given", () => {
  const name = "host.docker.internal";
  expect(onThisMachine("http://127.0.0.1:8765/ag-ui", name)).toBe(
    "http://host.docker.internal:8765/ag-ui",
  );
  expect(onThisMachine("http://localhost:8765/ag-ui", name)).toBe(
    "http://host.docker.internal:8765/ag-ui",
  );
  expect(onThisMachine("http://agent.localhost:8765/ag-ui", name)).toBe(
    "http://host.docker.internal:8765/ag-ui",
  );
  expect(onThisMachine("http://[::1]:8765/ag-ui", name)).toBe(
    "http://host.docker.internal:8765/ag-ui",
  );
  expect(onThisMachine("https://127.9.9.9/run?x=1", name)).toBe(
    "https://host.docker.internal/run?x=1",
  );
  // Not loopback: reached as written from a container too.
  for (const address of [
    "http://192.168.1.10:8765/ag-ui",
    "http://agent-harness:4202/run",
    "https://agents.example.com/ag-ui",
    "http://host.docker.internal:8765/ag-ui",
  ]) {
    expect(onThisMachine(address, name)).toBe(address);
  }
  // No setting, nothing moves.
  expect(onThisMachine("http://127.0.0.1:8765/ag-ui", undefined)).toBe(
    "http://127.0.0.1:8765/ag-ui",
  );
});

test("the setting is a host name and nothing else", () => {
  for (const bad of [
    "http://host.docker.internal",
    "host.docker.internal:80",
    "a/b",
  ]) {
    expect(() => configWith(bad)).toThrow(SETTING);
  }
  expect(configWith(" Host.Docker.Internal ").thisMachineHost).toBe(
    "host.docker.internal",
  );
  expect(configWith(undefined).thisMachineHost).toBeUndefined();
});
