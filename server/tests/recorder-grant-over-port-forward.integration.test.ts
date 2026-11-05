// The Recorder's capture pass on an OpenBot whose only address is a `kubectl port-forward`.
//
// The Helm chart that installs Intelligence beside OpenBot turns INTELLIGENCE_GATEWAY_PROXY on, so
// the gateway's client socket is reached through OpenBot's own address, and a vanilla install has no
// public URL: the person opens it at http://127.0.0.1:<port> over a port-forward, single-user. The page
// is told the socket as a path and resolves it against itself. The Recorder is not on the page, and
// was handed the same path in its capture pass, which the runtime refuses as no URL at all: every
// recording failed with a 502.
//
// Real paths: the real HTTP server, the app with the runtime and the Recorder's wiring mounted as
// index.ts mounts them, a real database, and one real server standing in for Intelligence, answering
// its trajectory join over HTTP and its gateway's `/client/websocket` as a socket.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type ExchangeResponse,
  recorderPaths,
} from "@openbot/shared/recorder-api";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { eq } from "drizzle-orm";
import { reservePort } from "../../tests/support/reserved-port";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import type { AgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import { DEV_ACTOR, initializeDevActorUser } from "../src/auth/dev-actor";
import type { RoleRepository } from "../src/auth/guards";
import { createStallGuard } from "../src/channels/stall-guard";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import {
  recorderConnections,
  recorderTrajectoryBindings,
} from "../src/db/schema/recorder";
import { startHttpServer } from "../src/http-server";
import { INTELLIGENCE_CLIENT_SOCKET_PATH } from "../src/intelligence-gateway-proxy";
import { personalLearningContainerId } from "../src/learning/personal-space";
import { createRecorderExtension } from "../src/recorder/wiring";
import { createRequestActor } from "../src/request-actor";
import { ownOriginOnThisMachine } from "../src/request-trust";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const RECORDER_ORIGIN = `chrome-extension://${RECORDER_EXTENSION_ID}`;
const INSTALL_ID = "e".repeat(32);

/** What the stand-in for Intelligence was asked: its trajectory joins, and the sockets opened on its gateway. */
const joins: Array<{ trajectoryId: string; appUserId: string }> = [];
const gatewaySockets: Array<{ path: string; search: string }> = [];
const gatewayHeard: string[] = [];

let intelligence: ReturnType<typeof Bun.serve>;
let openbot: { stop(closeActiveConnections?: boolean): Promise<void> };
let port: number;
let token: string;
const trajectories: string[] = [];
const guard = createStallGuard({ stallMs: 0 });

beforeAll(async () => {
  const intelligencePort = await reservePort();
  intelligence = Bun.serve({
    port: intelligencePort,
    hostname: "127.0.0.1",
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/client/websocket") {
        gatewaySockets.push({ path: url.pathname, search: url.search });
        if (server.upgrade(request, { data: undefined })) return undefined;
        return new Response("Expected a WebSocket upgrade.", { status: 400 });
      }
      // What the runtime asks before it answers the page's `/info`.
      if (url.pathname === "/api/entitlements/runtime")
        return Response.json({ status: "valid" });
      if (url.pathname === "/api/trajectories/join") {
        const body = (await request.json()) as (typeof joins)[number];
        joins.push(body);
        return Response.json({
          joinToken: `join-${joins.length}`,
          trajectoryId: body.trajectoryId,
        });
      }
      return Response.json(
        { error: { code: "ROUTE_NOT_FOUND" } },
        { status: 404 },
      );
    },
    websocket: {
      message(ws, message) {
        gatewayHeard.push(String(message));
        ws.send(message);
      },
    },
  });

  port = await reservePort();
  // As the chart writes it for a bundled Intelligence: in a container, single-user, the gateway
  // carried by OpenBot, and no public URL anywhere.
  const config = loadConfig({
    DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:5432/openbot",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    INTELLIGENCE_API_URL: `http://127.0.0.1:${intelligencePort}`,
    INTELLIGENCE_GATEWAY_WS_URL: `ws://127.0.0.1:${intelligencePort}`,
    INTELLIGENCE_API_KEY: "tenant-api-key",
    COPILOTKIT_LICENSE_TOKEN: "license-token",
    OPENBOT_SINGLE_USER: "true",
    OPENBOT_IN_CONTAINER: "true",
    INTELLIGENCE_GATEWAY_PROXY: "on",
  });
  expect(config.singleUser).toBe(true);
  expect(config.publicUrl).toBeUndefined();
  expect(config.runtime.intelligence.browserGatewayWsUrl).toBe(
    INTELLIGENCE_CLIENT_SOCKET_PATH,
  );

  const auditStore = { insert: async (_event: AuditEventInput) => {} };
  const roleRepository: RoleRepository = {
    rolesForUser: async () => ["admin"],
  };
  const recorder = createRecorderExtension({
    config,
    database,
    organizationAuth: undefined,
    roleRepository,
    peopleStore: { isRevoked: async () => false },
    personalSpaces: {
      containerFor: personalLearningContainerId,
      state: async (userId) => ({
        state: "assigned",
        containerId: personalLearningContainerId(userId),
      }),
      kick: () => {},
    },
    auditStore,
  });
  const { identifyUser, identifyActor, resolveRequestActor } =
    createRequestActor({
      singleUser: true,
      resolveRecorder: recorder.resolve,
      getSession: async () => null,
      rolesForUser: (id) => roleRepository.rolesForUser(id),
    });
  const runtime = mountCopilotRuntime(
    config,
    createActorAgentResolver({
      model: { provider: "openai", defaultModel: "unused" },
      // The page's `/info` names the Bots there are, and answers nothing without one.
      loadAgents: async () => [
        { id: "notes", name: "Notes", type: "built_in", systemPrompt: "Work." },
      ],
      resolveModelApiKey: async () => "synthetic-key",
      stallGuard: guard,
    }),
    identifyUser,
    identifyActor,
    { trajectoryCapture: recorder.trajectoryCapture },
  );
  /*
   * createApp is positional. Placed by index rather than after a spread of `undefined`s, whose length
   * TypeScript cannot see, so each dependency is type-checked against the parameter it lands on.
   */
  const args = new Array(createApp.length) as unknown as Parameters<
    typeof createApp
  >;
  args[0] = config;
  args[2] = roleRepository;
  args[6] = runtime.handler;
  args[12] = auditStore;
  args[34] = { recorder };
  openbot = startHttpServer({
    port,
    config,
    resolveRequestActor,
    agentProfileStore: {} as AgentProfileStore,
    computerGateway: undefined,
    app: createApp(...args),
  });

  await initializeDevActorUser(database, true);
  // Connected as the person connects it: a code minted on OpenBot's page, exchanged by the Recorder.
  const minted = await fetch(
    `http://127.0.0.1:${port}${recorderPaths.connectCodes}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ via: "web" }),
    },
  );
  expect(minted.status).toBe(201);
  const { code } = (await minted.json()) as { code: string };
  const exchanged = await fetch(
    `http://127.0.0.1:${port}${recorderPaths.connections}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: RECORDER_ORIGIN,
      },
      body: JSON.stringify({
        code,
        label: "Chrome on macOS",
        installId: INSTALL_ID,
      }),
    },
  );
  expect(exchanged.status).toBe(201);
  token = ((await exchanged.json()) as ExchangeResponse).token;
});

afterAll(async () => {
  await openbot?.stop(true);
  intelligence?.stop(true);
  guard.stop();
  for (const trajectoryId of trajectories)
    await database
      .delete(recorderTrajectoryBindings)
      .where(eq(recorderTrajectoryBindings.trajectoryId, trajectoryId));
  await database
    .delete(recorderConnections)
    .where(eq(recorderConnections.installId, INSTALL_ID));
  await database.$client.close();
});

/** The capture pass exactly as the Recorder asks for it, at the address it was connected to. */
function pass(headers: Record<string, string> = {}) {
  const trajectoryId = randomUUID();
  trajectories.push(trajectoryId);
  return fetch(
    `http://127.0.0.1:${port}${recorderPaths.trajectoryConnect(trajectoryId)}`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: RECORDER_ORIGIN,
        authorization: `Bearer ${token}`,
        ...headers,
      },
      body: "{}",
    },
  );
}

describe("the Recorder's capture pass over a port-forward, with no public URL", () => {
  test("names the gateway socket as a whole address on OpenBot, as the Recorder reached it", async () => {
    const answer = await pass();

    expect(answer.status).toBe(200);
    const grant = (await answer.json()) as {
      joinToken: string;
      realtime: { clientUrl: string; topic: string };
    };
    expect(grant.realtime.clientUrl).toBe(
      `ws://127.0.0.1:${port}${INTELLIGENCE_CLIENT_SOCKET_PATH}`,
    );
    expect(joins.at(-1)?.appUserId).toBe(DEV_ACTOR.id);
  });

  test("and that address carries the Recorder's socket through to the gateway", async () => {
    const grant = (await (await pass()).json()) as {
      joinToken: string;
      realtime: { clientUrl: string; topic: string };
    };
    gatewaySockets.length = 0;
    gatewayHeard.length = 0;
    // As Phoenix opens it: `/websocket` after the address it was given, the join token in the query.
    const socket = new WebSocket(
      `${grant.realtime.clientUrl}/websocket?vsn=2.0.0&join_token=${grant.joinToken}`,
      { headers: { origin: RECORDER_ORIGIN } } as unknown as string[],
    );
    const join = JSON.stringify([
      "1",
      "1",
      grant.realtime.topic,
      "phx_join",
      {},
    ]);
    const echoed = await new Promise<string>((resolve, reject) => {
      socket.onopen = () => socket.send(join);
      socket.onmessage = (event) => resolve(String(event.data));
      socket.onerror = () => reject(new Error("the socket failed"));
      setTimeout(() => reject(new Error("timed out")), 5_000);
    });
    socket.close();

    expect(echoed).toBe(join);
    expect(gatewaySockets).toEqual([
      {
        path: "/client/websocket",
        search: `?vsn=2.0.0&join_token=${grant.joinToken}`,
      },
    ]);
    expect(gatewayHeard).toEqual([join]);
  });

  test("never makes the address out of a name this machine does not answer to", async () => {
    const answer = await pass({ host: "openbot.attacker.example" });

    expect(answer.status).not.toBe(200);
    expect(await answer.text()).not.toContain("attacker");
  });

  test("leaves the page's address a path, which the page resolves against itself", async () => {
    const info = await fetch(`http://127.0.0.1:${port}/api/copilotkit/info`);

    expect(info.status).toBe(200);
    expect(
      ((await info.json()) as { intelligence?: { wsUrl?: string } })
        .intelligence?.wsUrl,
    ).toBe(INTELLIGENCE_CLIENT_SOCKET_PATH);
  });
});

describe("OpenBot's own origin, as a caller on this machine reached it", () => {
  const singleUser = {
    singleUser: true,
    singleUserAccess: { thisMachineOnly: false, hosts: [] },
  };
  const request = (host: string) =>
    new Request(`http://${host}/api/copilotkit/trajectory/x/connect`, {
      headers: { host },
    });

  test("is the Host a loopback caller named, when it is one of this machine's own names", () => {
    for (const [address, host, origin] of [
      // A port-forward's connection, as the pod sees it.
      ["127.0.0.1", "127.0.0.1:3101", "http://127.0.0.1:3101"],
      ["::1", "[::1]:3101", "http://[::1]:3101"],
      // A dual-stack socket's report of an IPv4 loopback peer.
      ["::ffff:127.0.0.1", "127.0.0.1:3001", "http://127.0.0.1:3001"],
      ["127.0.0.1", "localhost:3001", "http://localhost:3001"],
    ] as const) {
      expect(
        ownOriginOnThisMachine(request(host), { address }, singleUser),
      ).toBe(origin);
    }
  });

  test("is nothing for a caller on another machine, whatever Host it sends", () => {
    for (const address of ["10.0.12.7", "192.168.1.20", "2001:db8::7"]) {
      for (const host of ["127.0.0.1:3101", "10.0.0.5:3001", "openbot.test"])
        expect(
          ownOriginOnThisMachine(request(host), { address }, singleUser),
        ).toBeNull();
    }
  });

  test("is nothing for a name this machine does not answer to, or a caller nobody can name", () => {
    for (const host of [
      "openbot.attacker.example",
      "127.0.0.1.attacker.example",
      "10.0.0.5:3001",
    ])
      expect(
        ownOriginOnThisMachine(
          request(host),
          { address: "127.0.0.1" },
          singleUser,
        ),
      ).toBeNull();
    expect(
      ownOriginOnThisMachine(
        request("127.0.0.1:3101"),
        { address: null },
        singleUser,
      ),
    ).toBeNull();
    expect(
      ownOriginOnThisMachine(request("127.0.0.1:3101"), undefined, singleUser),
    ).toBeNull();
  });
});
