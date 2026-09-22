import { expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AgentProfile } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import type { AgentChannel, ChannelStore } from "../src/channels/routes";
import type { VoiceConnection, VoiceProvider } from "../src/voice/provider";
import { createVoiceRoutes as voiceRoutes } from "../src/voice/routes";

const profile: AgentProfile = {
  id: "agent-1",
  name: "Actual agent name",
  title: "Researcher",
  roleDescription: "Investigate carefully.",
  avatarSeed: "a",
  visibility: "public",
  ownerUserId: null,
  systemOwned: false,
  hidden: false,
  deletedAt: null,
  endpoint: null,
  hasAuth: false,
  hasCallbackToken: false,
};
function createVoiceRoutes(...args: Parameters<typeof voiceRoutes>) {
  return voiceRoutes(
    args[0],
    args[1],
    args[2],
    args[3] ?? { get: async () => profile },
    args[4],
  );
}

const actor = {
  id: "user-1",
  email: "user@example.com",
  role: "user",
} as const;
const user: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};
const sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const connection: VoiceConnection = { transport: "webrtc", sdp };
const channel: AgentChannel = {
  id: "channel-1",
  name: "Research",
  agentIds: ["agent-1"],
  threadId: "thread-1",
  active: true,
  lastMessageAt: null,
};
const channels: Pick<ChannelStore, "get"> = { get: async () => channel };
function request(body: unknown = { channelId: channel.id, sdp }): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-openbot-voice": "1" },
    body: JSON.stringify(body),
  };
}

test("authentication, CSRF header, membership, and active single-agent channel precede provider access", async () => {
  let calls = 0;
  const provider: VoiceProvider = {
    transport: "webrtc",
    connect: async () => {
      calls++;
      return connection;
    },
  };
  const unauthorized = createVoiceRoutes(
    (context) => context.json({ error: "Unauthorized" }, 401),
    provider,
    channels,
  );
  expect((await unauthorized.request("/calls", request())).status).toBe(401);
  const app = createVoiceRoutes(user, provider, channels);
  expect(
    (
      await app.request("/calls", {
        ...request(),
        headers: { "content-type": "application/json" },
      })
    ).status,
  ).toBe(403);
  const inaccessible: Array<[AgentChannel | null, number]> = [
    [null, 404],
    [{ ...channel, active: false }, 409],
    [{ ...channel, agentIds: ["a", "b"] }, 400],
  ];
  for (const [result, status] of inaccessible) {
    const routes = createVoiceRoutes(user, provider, {
      get: async (receivedActor, id) => {
        expect(receivedActor).toEqual(actor);
        expect(id).toBe(channel.id);
        return result;
      },
    });
    expect((await routes.request("/calls", request())).status).toBe(status);
  }
  expect(calls).toBe(0);
});

test("disabled service returns 503 and successful handshakes return uncached connection details", async () => {
  expect(
    (
      await createVoiceRoutes(user, undefined, channels).request(
        "/calls",
        request(),
      )
    ).status,
  ).toBe(503);
  const app = createVoiceRoutes(
    user,
    {
      transport: "webrtc",
      connect: async (input) => {
        expect(input).toMatchObject({
          sdp,
          agentName: profile.name,
          userId: actor.id,
        });
        expect(input.signal).toBeInstanceOf(AbortSignal);
        return connection;
      },
    },
    channels,
  );
  const response = await app.request("/calls", request());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual(connection);
});

test("transport configuration is authenticated and Grok connects without an SDP offer", async () => {
  let calls = 0;
  const websocket: VoiceConnection = {
    transport: "websocket",
    url: "wss://api.x.ai/v1/realtime?model=grok-voice-latest",
    clientSecret: "ephemeral",
    session: {},
  };
  const provider: VoiceProvider = {
    transport: "websocket",
    connect: async (input) => {
      expect(input.sdp).toBeUndefined();
      expect(input.agentName).toBe(profile.name);
      calls++;
      return websocket;
    },
  };
  const unauthorized = createVoiceRoutes(
    (context) => context.json({ error: "Unauthorized" }, 401),
    provider,
    channels,
  );
  expect((await unauthorized.request("/config")).status).toBe(401);
  expect(
    (await unauthorized.request("/calls", request({ channelId: channel.id })))
      .status,
  ).toBe(401);
  const notMember = createVoiceRoutes(user, provider, {
    get: async () => null,
  });
  expect(
    (await notMember.request("/calls", request({ channelId: channel.id })))
      .status,
  ).toBe(404);
  const app = createVoiceRoutes(user, provider, channels);
  const configResponse = await app.request("/config");
  expect(configResponse.headers.get("cache-control")).toBe("no-store");
  expect(await configResponse.json()).toEqual({ transport: "websocket" });
  expect(calls).toBe(0);
  const result = await app.request(
    "/calls",
    request({ channelId: channel.id }),
  );
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual(websocket);
  expect(calls).toBe(1);
  expect(
    (await createVoiceRoutes(user, undefined, channels).request("/config"))
      .status,
  ).toBe(503);
  expect(
    (
      await createVoiceRoutes(user, provider, undefined).request(
        "/calls",
        request(),
      )
    ).status,
  ).toBe(503);
});

test("times out even if a provider ignores cancellation and releases the handshake slot", async () => {
  let calls = 0;
  let upstreamSignal: AbortSignal | undefined;
  const app = createVoiceRoutes(
    user,
    {
      transport: "webrtc",
      connect: async ({ signal }) => {
        upstreamSignal = signal;
        calls++;
        if (calls === 1) return new Promise<VoiceConnection>(() => {});
        return connection;
      },
    },
    channels,
  );
  const response = await app.request("/calls", request());
  expect(response.status).toBe(504);
  expect(upstreamSignal?.aborted).toBe(true);
  expect((await app.request("/calls", request())).status).toBe(200);
}, 25_000);

test("rejects malformed, non-SDP, and oversized request bodies before provider access", async () => {
  let calls = 0;
  const provider: VoiceProvider = {
    transport: "webrtc",
    connect: async () => {
      calls++;
      return connection;
    },
  };
  for (const body of [
    null,
    {},
    { channelId: "", sdp },
    { channelId: channel.id, sdp: "not sdp" },
    { channelId: channel.id, sdp: `${sdp}${"x".repeat(128 * 1024)}` },
  ]) {
    const response = await createVoiceRoutes(user, provider, channels).request(
      "/calls",
      request(body),
    );
    expect([400, 413]).toContain(response.status);
  }
  const response = await createVoiceRoutes(user, provider, channels).request(
    "/calls",
    { ...request(), body: "{" },
  );
  expect(response.status).toBe(400);
  expect(calls).toBe(0);
});

test("provider errors do not leak secrets; attempts are bounded", async () => {
  const app = createVoiceRoutes(
    user,
    {
      transport: "webrtc",
      connect: async () => {
        throw new Error("secret-key");
      },
    },
    channels,
  );
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await app.request("/calls", request());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret-key");
  }
  expect((await app.request("/calls", request())).status).toBe(429);
});

test("allows one handshake per user, propagates cancellation, and releases its slot", async () => {
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  let upstreamSignal: AbortSignal | undefined;
  let calls = 0;
  const app = createVoiceRoutes(
    user,
    {
      transport: "webrtc",
      connect: async ({ signal }) => {
        calls++;
        if (calls > 1) return connection;
        upstreamSignal = signal;
        started.resolve();
        return new Promise<VoiceConnection>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    },
    channels,
  );
  const first = app.request("/calls", {
    ...request(),
    signal: controller.signal,
  });
  await started.promise;
  expect((await app.request("/calls", request())).status).toBe(429);
  controller.abort();
  expect((await first).status).toBe(504);
  expect(upstreamSignal?.aborted).toBe(true);
  expect((await app.request("/calls", request())).status).toBe(200);
});

test("voice identity comes from the authorized profile and unavailable profiles never reach the provider", async () => {
  let calls = 0;
  const provider: VoiceProvider = {
    transport: "webrtc",
    connect: async (input) => {
      calls++;
      expect(input).toMatchObject({
        agentName: profile.name,
        agentTitle: profile.title,
        agentRole: profile.roleDescription,
      });
      return connection;
    },
  };
  const app = createVoiceRoutes(user, provider, channels, {
    get: async (receivedActor, id) => {
      expect(receivedActor.id).toBe(actor.id);
      expect(id).toBe(channel.agentIds[0]);
      return profile;
    },
  });
  expect((await app.request("/calls", request())).status).toBe(200);
  for (const missing of [null, { ...profile, deletedAt: new Date() }]) {
    expect(
      (
        await createVoiceRoutes(user, provider, channels, {
          get: async () => missing,
        }).request("/calls", request())
      ).status,
    ).toBe(404);
  }
  const failing = createVoiceRoutes(user, provider, channels, {
    get: async () => {
      throw new Error("database-secret");
    },
  });
  const response = await failing.request("/calls", request());
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("database-secret");
  expect(calls).toBe(1);
});
