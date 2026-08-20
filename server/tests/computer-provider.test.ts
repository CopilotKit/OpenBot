import { afterEach, describe, expect, test } from "bun:test";
import type { ComputerConfig } from "../src/config";
import {
  createComputerProvider,
  createSharedComputerProvider,
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

describe("shared computer provider", () => {
  test("describes the shared browser and how to isolate Bots", () => {
    const provider = createSharedComputerProvider({
      baseUrl: "http://computer:4100/",
    });

    expect(provider.name).toBe("shared");
    expect(provider.isolation).toBe("shared");
    expect(provider.describeIsolation()).toEqual({
      isolation: "one shared computer",
      note: "No supervisor is configured, so every Bot uses the same browser. Sessions, files and logins are shared between them. Set COMPUTER_SUPERVISOR_URL or DAYTONA_API_KEY to give each Bot its own.",
      warning: "Every Bot shares one browser. Set COMPUTER_SUPERVISOR_URL or DAYTONA_API_KEY for a computer each.",
    });
    expect(provider.locate("sales")).resolves.toBe("http://computer:4100/");
  });

  test("reports a healthy shared computer as ready", async () => {
    const paths: string[] = [];
    const baseUrl = serve((request) => {
      paths.push(new URL(request.url).pathname);
      return Response.json({ status: "ok" });
    });
    const provider = createSharedComputerProvider({ baseUrl });

    expect(await provider.status("sales")).toEqual({
      botId: "sales",
      state: "ready",
    });
    expect(paths).toEqual(["/health"]);
  });

  test("reports the HTTP failure when the shared computer is not healthy", async () => {
    const baseUrl = serve(() => new Response("not ready", { status: 503 }));
    const provider = createSharedComputerProvider({ baseUrl });

    expect(await provider.status("sales")).toEqual({
      botId: "sales",
      state: "unreachable",
      reason: "The shared computer answered 503.",
    });
  });

  test("sends lifecycle requests with the Bot identity and computer token", async () => {
    const requests: {
      path: string;
      method: string;
      botId: string | null;
      token: string | null;
    }[] = [];
    const baseUrl = serve((request) => {
      requests.push({
        path: new URL(request.url).pathname,
        method: request.method,
        botId: request.headers.get("x-openbot-bot-id"),
        token: request.headers.get("x-openbot-computer-token"),
      });
      return Response.json({ ok: true });
    });
    const provider = createSharedComputerProvider({
      baseUrl,
      token: "computer-secret",
    });

    await provider.stop("sales");
    await provider.reset("sales");

    expect(requests).toEqual([
      {
        path: "/stop",
        method: "POST",
        botId: "sales",
        token: "computer-secret",
      },
      {
        path: "/reset",
        method: "POST",
        botId: "sales",
        token: "computer-secret",
      },
    ]);
  });

  test("maps the shared computer inventory to provider locations", async () => {
    const baseUrl = serve(() =>
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
            egress: null,
          },
        ],
      }),
    );
    const provider = createSharedComputerProvider({ baseUrl });

    expect(await provider.list()).toEqual([
      {
        botId: "sales",
        status: "running",
        url: baseUrl,
        startedAt: "2026-08-20T12:00:00.000Z",
      },
      {
        botId: "support",
        status: "stopped",
        url: baseUrl,
      },
    ]);
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

  test("selects the Daytona adapter", () => {
    const config: ComputerConfig = {
      provider: "daytona",
      apiKey: "daytona-key",
      token: "computer-secret",
      allowPrivateHosts: false,
      snapshot: "prebuilt",
    };

    expect(createComputerProvider(config).name).toBe("Daytona");
  });
});
