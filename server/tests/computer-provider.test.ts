import { afterEach, describe, expect, test } from "bun:test";
import {
  botSeat,
  type ComputerSeat,
  personSeat,
} from "../src/computer/computer-key";
import {
  createComputerProvider,
  createSharedComputerProvider,
  describeComputerIsolation,
  ProviderError,
} from "../src/computer/provider";
import type { ComputerConfig } from "../src/config";

/** Ada's seat on a Bot, which is what every call to the shared computer is now made for. */
const ada = (botId: string): ComputerSeat => personSeat("ada", botId);
const adaKey = { kind: "person", personId: "ada" } as const;

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
  run?: (request: Request) => Response | Promise<Response>;
  carryOver?: (request: Request) => Response | Promise<Response>;
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

    if (url.pathname === "/run" && request.method === "GET") {
      if (handlers.run) return handlers.run(request);
      return Response.json({ run: "run-1" });
    }

    if (url.pathname === "/computers/carry-over" && request.method === "POST") {
      if (handlers.carryOver) return handlers.carryOver(request);
      return Response.json({ outcome: "moved" });
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
    expect(await provider.locate(ada("sales"))).toBe("http://computer:4100/");
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

    expect(await provider.status(ada("sales"))).toEqual({
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

    expect(await provider.status(ada("sales"))).toEqual({
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
      person: string | null;
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
            person: request.headers.get("x-openbot-person-id"),
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

    const runningResult = await provider.stop({
      key: adaKey,
      botId: "running-bot",
    });
    expect(runningResult).toEqual({ wasRunning: true });

    const idleResult = await provider.stop({ key: adaKey, botId: "idle-bot" });
    expect(idleResult).toEqual({ wasRunning: false });

    // The person travels with the Bot, so the stop reaches Ada's seat and nobody else's.
    expect(requests).toEqual([
      {
        path: "/computers/stop",
        method: "POST",
        botId: "running-bot",
        person: "ada",
        token: "computer-secret",
      },
      {
        path: "/computers/stop",
        method: "POST",
        botId: "idle-bot",
        person: "ada",
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

    const resetResult = await provider.reset({ key: adaKey, botId: "sales" });
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
            {
              seat: "ada~sales",
              botId: "sales",
              personId: "ada",
              running: true,
              egress: null,
            },
          ],
        }),
    });
    const provider = createSharedComputerProvider({ baseUrl });

    expect(await provider.list()).toEqual([
      {
        key: { kind: "bot", botId: "sales" },
        botId: "sales",
        status: "running",
        url: baseUrl,
        startedAt: "2026-08-20T12:00:00.000Z",
        egress: null,
      },
      {
        key: { kind: "bot", botId: "support" },
        botId: "support",
        status: "stopped",
        url: baseUrl,
        egress: "us-east-egress",
      },
      {
        key: { kind: "bot", botId: "analytics" },
        botId: "analytics",
        status: "running",
        url: baseUrl,
        egress: null,
      },
      // A seat names whose it is: Ada's profile for that Bot, not the Bot's for everyone.
      {
        key: { kind: "person", personId: "ada" },
        botId: "sales",
        status: "running",
        url: baseUrl,
        egress: null,
      },
    ]);
  });

  /**
   * Which run of the shared computer this is.
   *
   * The one part of the boundary that has no infrastructure to read it off. A Bot with its own
   * container gets a run from the container, and a sandbox gets one from the moment its browser last
   * became ready, but every Bot here shares one container that outlives every reset, so the only
   * thing that knows a browser session was replaced is the computer itself. Without an answer the
   * server orders snapshots on the generation alone, which is the ordering that cannot tell a save
   * left over from a wiped session apart from the fresh browser's first.
   */
  test("reports the run the computer says this Bot's browser is on", async () => {
    const asked: {
      path: string;
      botId: string | null;
      token: string | null;
    }[] = [];
    const baseUrl = serveAgentComputer(
      {
        run: (request) => {
          asked.push({
            path: new URL(request.url).pathname,
            botId: request.headers.get("x-openbot-bot-id"),
            token: request.headers.get("x-openbot-computer-token"),
          });
          return Response.json({ run: "d7c0f1" });
        },
      },
      { token: "computer-secret" },
    );
    const provider = createSharedComputerProvider({
      baseUrl,
      token: "computer-secret",
    });

    expect(await provider.sessionOf?.(ada("sales"))).toBe("d7c0f1");
    // Addressed and authenticated like every other call, or one Bot would be told about another's.
    expect(asked).toEqual([
      { path: "/run", botId: "sales", token: "computer-secret" },
    ]);
  });

  test("each Bot gets its own, because they share the container and nothing else", async () => {
    const baseUrl = serveAgentComputer({
      run: (request) =>
        Response.json({
          run: `run-of-${request.headers.get("x-openbot-bot-id")}`,
        }),
    });
    const provider = createSharedComputerProvider({ baseUrl });

    expect(await provider.sessionOf?.(ada("sales"))).toBe("run-of-sales");
    expect(await provider.sessionOf?.(ada("analytics"))).toBe(
      "run-of-analytics",
    );
  });

  test("asks again rather than remembering, because a restart is not announced", async () => {
    // The supervisor caches because `/ensure` refreshes it on every action. Nothing refreshes this
    // one: `locate` here is a string and makes no call, so a remembered run would say "same run"
    // for the whole life of the process, which is the answer this exists to stop giving.
    let run = "run-1";
    const baseUrl = serveAgentComputer({
      run: () => Response.json({ run }),
    });
    const provider = createSharedComputerProvider({ baseUrl });

    expect(await provider.sessionOf?.(ada("sales"))).toBe("run-1");
    run = "run-2";
    expect(await provider.sessionOf?.(ada("sales"))).toBe("run-2");
  });

  test("answers undefined when the computer cannot say, rather than throwing", async () => {
    // A computer from before this endpoint existed, or one that is not answering. Unknown is not
    // mismatched: the comparison goes back to being skipped, which is where it started, and a
    // refusal on every ref would be a far worse failure than the one being fixed.
    const baseUrl = serveAgentComputer({
      run: () => Response.json({ error: "Not found." }, { status: 404 }),
    });
    const provider = createSharedComputerProvider({ baseUrl });

    // Asserted first, or a provider with no `sessionOf` at all would pass this vacuously.
    expect(provider.sessionOf).toBeDefined();
    expect(await provider.sessionOf?.(ada("sales"))).toBeUndefined();
  });

  test("answers undefined when the computer answers without one", async () => {
    const baseUrl = serveAgentComputer({ run: () => Response.json({}) });
    const provider = createSharedComputerProvider({ baseUrl });

    // Asserted first, or a provider with no `sessionOf` at all would pass this vacuously.
    expect(provider.sessionOf).toBeDefined();
    expect(await provider.sessionOf?.(ada("sales"))).toBeUndefined();
  });

  test("aborts fetch that never settles with configurable timeoutMs and throws ProviderError", async () => {
    const baseUrl = serve(() => new Promise<Response>(() => {}));
    const provider = createSharedComputerProvider({
      baseUrl,
      timeoutMs: 25,
    });

    await expect(
      provider.stop({ key: adaKey, botId: "sales" }),
    ).rejects.toThrow(ProviderError);
  });
});

/**
 * One computer for everybody, and a seat on it per person and Bot.
 *
 * The regression: every layer keyed the shared computer by the Bot alone, so a public Bot had one
 * profile there, and whoever signed it into a site signed it in for everybody using it.
 */
describe("seats on the shared computer", () => {
  test("two people on one public Bot reach two seats, so neither sees the other's logins", async () => {
    const seen: string[] = [];
    const baseUrl = serveAgentComputer({
      run: (request) => {
        const seat = `${request.headers.get("x-openbot-person-id")}~${request.headers.get("x-openbot-bot-id")}`;
        seen.push(seat);
        return Response.json({ run: `run-of-${seat}` });
      },
    });
    const provider = createSharedComputerProvider({ baseUrl });

    const adas = await provider.sessionOf?.(personSeat("ada", "pub-bot"));
    const bos = await provider.sessionOf?.(personSeat("bo", "pub-bot"));
    expect(adas).toBe("run-of-ada~pub-bot");
    expect(bos).toBe("run-of-bo~pub-bot");
    expect(seen).toEqual(["ada~pub-bot", "bo~pub-bot"]);
  });

  test("a private Bot's old profile is asked for once, for its owner's seat", async () => {
    const asked: (string | null)[][] = [];
    const baseUrl = serveAgentComputer({
      carryOver: (request) => {
        asked.push([
          request.headers.get("x-openbot-person-id"),
          request.headers.get("x-openbot-bot-id"),
        ]);
        return Response.json({ outcome: "moved" });
      },
    });
    const provider = createSharedComputerProvider({ baseUrl });
    const owners = { ...personSeat("ada", "notes"), inheritsProfile: true };

    await provider.locate(owners);
    await provider.locate(owners);
    expect(asked).toEqual([["ada", "notes"]]);
  });

  test("a public Bot's seat never takes the old shared profile", async () => {
    let asked = 0;
    const baseUrl = serveAgentComputer({
      carryOver: () => {
        asked += 1;
        return Response.json({ outcome: "moved" });
      },
    });
    const provider = createSharedComputerProvider({ baseUrl });

    await provider.locate(personSeat("bo", "pub-bot"));
    expect(asked).toBe(0);
  });

  test("stopping a person's computer stops every seat of theirs and no one else's", async () => {
    const stopped: string[] = [];
    const baseUrl = serveAgentComputer({
      computers: () =>
        Response.json({
          computers: [
            {
              seat: "ada~sales",
              botId: "sales",
              personId: "ada",
              running: true,
            },
            {
              seat: "ada~notes",
              botId: "notes",
              personId: "ada",
              running: true,
            },
            { seat: "bo~sales", botId: "sales", personId: "bo", running: true },
          ],
        }),
      stop: (request) => {
        stopped.push(
          `${request.headers.get("x-openbot-person-id")}~${request.headers.get("x-openbot-bot-id")}`,
        );
        return Response.json({ stopped: true, wasRunning: true });
      },
    });
    const provider = createSharedComputerProvider({ baseUrl });

    expect(await provider.stop({ key: adaKey })).toEqual({ wasRunning: true });
    expect(stopped).toEqual(["ada~sales", "ada~notes"]);
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

/**
 * A transient failure must not become a permanent one.
 *
 * The provider is built once behind a promise, and `??=` remembers whatever that first call
 * produced. A rejected promise is something: one unreadable token file at the wrong moment and every
 * computer request for the rest of the pod's life failed with the same stale error, while the pod
 * served happily and no probe noticed.
 */
describe("building the sandbox provider", () => {
  test("a failed first attempt is not remembered", async () => {
    const original = process.env.KUBERNETES_SERVICE_HOST;
    delete process.env.KUBERNETES_SERVICE_HOST;

    try {
      const provider = createComputerProvider({
        provider: "sandbox",
        namespace: "openbot",
        idleAfterMs: 60_000,
        templateFile: "/nowhere/sandbox-template.json",
      });

      const first = await provider
        .status(botSeat("bot-1"))
        .catch((e: unknown) => e);
      const second = await provider
        .status(botSeat("bot-1"))
        .catch((e: unknown) => e);

      expect(first).toBeInstanceOf(Error);
      expect(second).toBeInstanceOf(Error);
      /*
       * DIFFERENT OBJECTS, which is the whole assertion.
       *
       * A memo holding the rejected promise hands back the identical Error every time, because
       * nothing runs again. Two distinct instances mean the second call re-entered the build, so a
       * deployment whose token file was briefly unreadable recovers on the next request instead of
       * needing a restart.
       */
      expect(second).not.toBe(first);
    } finally {
      if (original === undefined) delete process.env.KUBERNETES_SERVICE_HOST;
      else process.env.KUBERNETES_SERVICE_HOST = original;
    }
  });
});
