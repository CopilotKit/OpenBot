import { afterEach, describe, expect, test } from "bun:test";
import type { ComputerConfig } from "../src/config";
import {
  createComputerProvider,
  createSharedComputerProvider,
  describeComputerIsolation,
  ProviderError,
} from "../src/computer/provider";

const servers: { stop(closeActiveConnections?: boolean): void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

type FakeAgentComputerHandler = {
  health?: (request: Request) => Response | Promise<Response>;
  computers?: (request: Request) => Response | Promise<Response>;
  stop?: (request: Request) => Response | Promise<Response>;
  reset?: (request: Request) => Response | Promise<Response>;
};

function serveAgentComputer(
  handlers: FakeAgentComputerHandler = {},
  options?: { token?: string },
) {
  return serve(async (request) => {
    const url = new URL(request.url);
    const token = request.headers.get("x-openbot-computer-token");

    if (
      options?.token &&
      url.pathname !== "/health" &&
      token !== options.token
    ) {
      return Response.json({ error: "Not authorised." }, { status: 401 });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      if (handlers.health) return handlers.health(request);
      return Response.json({ status: "ok", browser: true });
    }

    if (url.pathname === "/computers" && request.method === "GET") {
      if (handlers.computers) return handlers.computers(request);
      return Response.json({ computers: [] });
    }

    if (url.pathname === "/computers/stop" && request.method === "POST") {
      if (handlers.stop) return handlers.stop(request);
      return Response.json({ stopped: true, wasRunning: true });
    }

    if (url.pathname === "/computers/reset" && request.method === "POST") {
      if (handlers.reset) return handlers.reset(request);
      const botId = request.headers.get("x-openbot-bot-id") ?? "shared";
      return Response.json({ reset: true, botId });
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  });
}

describe("computer isolation description", () => {
  test("describes the computer feature as off when no provider is configured", () => {
    const description = describeComputerIsolation(undefined);
    expect(description.isolation).toBe("off");
    expect(description.note.toLowerCase()).toContain("off");
    expect(description.note.toLowerCase()).not.toContain("shared");
    expect(description.note.toLowerCase()).not.toContain("browser");
  });

  test("describes provider machine isolation when configured", () => {
    const provider = createSharedComputerProvider({
      baseUrl: "http://computer:4100/",
    });

    expect(provider.name).toBe("shared");
    expect(provider.isolation).toBe("shared");
    expect(describeComputerIsolation(provider).isolation).toBe(
      "one shared computer",
    );
  });
});

describe("shared computer provider", () => {
  test("locates the shared computer address", async () => {
    const provider = createSharedComputerProvider({
      baseUrl: "http://computer:4100/",
    });
    expect(await provider.locate("sales")).toBe("http://computer:4100/");
  });

  test("reports a healthy shared computer as ready", async () => {
    const paths: string[] = [];
    const baseUrl = serveAgentComputer({
      health: (request) => {
        paths.push(new URL(request.url).pathname);
        return Response.json({ status: "ok" });
      },
    });
    const provider = createSharedComputerProvider({ baseUrl });

    expect(await provider.status("sales")).toEqual({
      botId: "sales",
      state: "ready",
    });
    expect(paths).toEqual(["/health"]);
  });

  test("reports the HTTP failure when the shared computer is not healthy", async () => {
    const baseUrl = serveAgentComputer({
      health: () => new Response("not ready", { status: 503 }),
    });
    const provider = createSharedComputerProvider({ baseUrl });

    expect(await provider.status("sales")).toEqual({
      botId: "sales",
      state: "unreachable",
      reason: "The shared computer answered 503.",
    });
  });

  test("posts /computers/stop with identity and token and returns wasRunning", async () => {
    const requests: {
      path: string;
      method: string;
      botId: string | null;
      token: string | null;
    }[] = [];
    const baseUrl = serveAgentComputer(
      {
        stop: (request) => {
          const botId = request.headers.get("x-openbot-bot-id");
          requests.push({
            path: new URL(request.url).pathname,
            method: request.method,
            botId,
            token: request.headers.get("x-openbot-computer-token"),
          });
          const wasRunning = botId === "running-bot";
          return Response.json({ stopped: true, wasRunning });
        },
      },
      { token: "computer-secret" },
    );
    const provider = createSharedComputerProvider({
      baseUrl,
      token: "computer-secret",
    });

    const runningResult = await provider.stop("running-bot");
    expect(runningResult).toEqual({ wasRunning: true });

    const idleResult = await provider.stop("idle-bot");
    expect(idleResult).toEqual({ wasRunning: false });

    expect(requests).toEqual([
      {
        path: "/computers/stop",
        method: "POST",
        botId: "running-bot",
        token: "computer-secret",
      },
      {
        path: "/computers/stop",
        method: "POST",
        botId: "idle-bot",
        token: "computer-secret",
      },
    ]);
  });

  test("posts /computers/reset with identity and token and returns cleared", async () => {
    const requests: {
      path: string;
      method: string;
      botId: string | null;
      token: string | null;
    }[] = [];
    const baseUrl = serveAgentComputer(
      {
        reset: (request) => {
          const botId = request.headers.get("x-openbot-bot-id");
          requests.push({
            path: new URL(request.url).pathname,
            method: request.method,
            botId,
            token: request.headers.get("x-openbot-computer-token"),
          });
          return Response.json({ reset: true, botId });
        },
      },
      { token: "computer-secret" },
    );
    const provider = createSharedComputerProvider({
      baseUrl,
      token: "computer-secret",
    });

    const resetResult = await provider.reset("sales");
    expect(resetResult).toEqual({ cleared: true });

    expect(requests).toEqual([
      {
        path: "/computers/reset",
        method: "POST",
        botId: "sales",
        token: "computer-secret",
      },
    ]);
  });

  test("maps the shared computer inventory to provider locations preserving egress and status", async () => {
    const baseUrl = serveAgentComputer({
      computers: () =>
        Response.json({
          computers: [
            {
              botId: "sales",
              running: true,
              startedAt: "2026-08-20T12:00:00.000Z",
              egress: null,
            },
            {
              botId: "support",
              running: false,
              startedAt: null,
              egress: "us-east-egress",
            },
            {
              botId: "analytics",
              status: "running",
              egress: null,
            },
          ],
        }),
    });
    const provider = createSharedComputerProvider({ baseUrl });

    expect(await provider.list()).toEqual([
      {
        botId: "sales",
        status: "running",
        url: baseUrl,
        startedAt: "2026-08-20T12:00:00.000Z",
        egress: null,
      },
      {
        botId: "support",
        status: "stopped",
        url: baseUrl,
        egress: "us-east-egress",
      },
      {
        botId: "analytics",
        status: "running",
        url: baseUrl,
        egress: null,
      },
    ]);
  });

  test("aborts fetch that never settles with configurable timeoutMs and throws ProviderError", async () => {
    const baseUrl = serve(() => new Promise<Response>(() => {}));
    const provider = createSharedComputerProvider({
      baseUrl,
      timeoutMs: 25,
    });

    await expect(provider.stop("sales")).rejects.toThrow(ProviderError);
  });
});

describe("computer provider factory", () => {
  test("selects the Docker supervisor adapter", () => {
    const config: ComputerConfig = {
      provider: "docker",
      baseUrl: "http://supervisor:4300",
      supervisorToken: "supervisor-secret",
      token: "computer-secret",
      allowPrivateHosts: false,
    };

    expect(createComputerProvider(config).name).toBe("Docker supervisor");
  });

  test("selects the shared computer adapter", () => {
    const config: ComputerConfig = {
      provider: "shared",
      baseUrl: "http://computer:4100",
      token: "computer-secret",
      allowPrivateHosts: false,
    };

    expect(createComputerProvider(config).name).toBe("shared");
  });
});
