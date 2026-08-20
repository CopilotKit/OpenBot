import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaytonaSupervisorClient } from "../src/computer/daytona";
import { SupervisorError } from "../src/computer/supervisor";

/**
 * Daytona computer provider test suite.
 *
 * OpenBot gives each Bot its own computer in a remote Daytona sandbox when configured with
 * DAYTONA_API_KEY. The supervisor client is responsible for creating, locating, stopping,
 * resetting, and listing these sandboxes via the Daytona SDK and validating readiness
 * over the sandbox preview URL before returning it to the caller.
 */

class DaytonaNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaytonaNotFoundError";
  }
}

type FakeSandbox = {
  id: string;
  state: string;
  labels: Record<string, string>;
  envVars: Record<string, string>;
  public: boolean;
  autoStopInterval: number;
  createdAt: string;
  previewUrl: string;
  startCalls: number;
  stopCalls: number;
  deleteCalls: number;
  deleteHandler?: (timeout?: number, wait?: boolean) => void | Promise<void>;
};

type CreateParams = {
  snapshot: string;
  envVars: Record<string, string>;
  labels: Record<string, string>;
  public: boolean;
  autoStopInterval: number;
  options?: { timeout?: number };
};

function makeSandboxHandle(sb: FakeSandbox) {
  return {
    id: sb.id,
    state: sb.state,
    labels: sb.labels,
    createdAt: sb.createdAt,
    start: async () => {
      sb.startCalls++;
      sb.state = "started";
    },
    stop: async () => {
      sb.stopCalls++;
      sb.state = "stopped";
    },
    delete: async (timeout?: number, wait?: boolean) => {
      sb.deleteCalls++;
      if (sb.deleteHandler) {
        await sb.deleteHandler(timeout, wait);
      } else {
        sb.state = "destroyed";
      }
    },
    getPreviewLink: async (_port: number) => ({ url: sb.previewUrl }),
  };
}

function createFakeSdk(initialSandboxes: FakeSandbox[] = []) {
  let idCounter = 1;
  const sandboxes = new Map<string, FakeSandbox>();
  const snapshots = new Map<string, { state: string }>();
  const creates: CreateParams[] = [];

  for (const sb of initialSandboxes) {
    sandboxes.set(sb.id, sb);
  }

  const sdk = {
    sandboxes,
    snapshots,
    creates,
    create: async (
      params: {
        snapshot: string;
        envVars: Record<string, string>;
        labels: Record<string, string>;
        public: boolean;
        autoStopInterval: number;
      },
      options?: { timeout?: number },
    ) => {
      creates.push({ ...params, options });
      const id = `sb-${idCounter++}`;
      const sb: FakeSandbox = {
        id,
        state: "started",
        labels: params.labels,
        envVars: params.envVars,
        public: params.public,
        autoStopInterval: params.autoStopInterval,
        createdAt: new Date().toISOString(),
        previewUrl: `https://${id}.preview.daytona.app`,
        startCalls: 0,
        stopCalls: 0,
        deleteCalls: 0,
      };
      sandboxes.set(id, sb);
      return makeSandboxHandle(sb);
    },
    get: async (id: string) => {
      const sb = sandboxes.get(id);
      if (!sb) {
        throw new DaytonaNotFoundError(`Sandbox ${id} not found`);
      }
      return makeSandboxHandle(sb);
    },
    list: (query?: { labels?: Record<string, string> }) => {
      async function* generator() {
        for (const sb of sandboxes.values()) {
          if (query?.labels) {
            const matches = Object.entries(query.labels).every(
              ([k, v]) => sb.labels[k] === v,
            );
            if (!matches) continue;
          }
          yield makeSandboxHandle(sb);
        }
      }
      return generator();
    },
    snapshot: {
      get: async (name: string) => {
        const snap = snapshots.get(name);
        if (!snap) {
          throw new DaytonaNotFoundError(`Snapshot ${name} not found`);
        }
        return snap;
      },
      create: async (
        params: { name: string; image: unknown },
        _options?: { onLogs?: (line: string) => void; timeout?: number },
      ) => {
        snapshots.set(params.name, { state: "active" });
        return { name: params.name };
      },
    },
  };

  return sdk;
}

function fakeFetch(
  handler?: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (handler) return handler(url, init);
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    return new Response("Not Found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("Daytona computer supervisor", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // cleanup best-effort
      }
    }
    tempDirs.length = 0;
  });

  test("create carries snapshot, both ownership labels, public:true, autoStopInterval:15, COMPUTER_TOKEN and COMPUTER_BOT_ID then returns preview URL after healthy /health", async () => {
    const sdk = createFakeSdk();
    let healthCheckedUrl: string | undefined;
    let healthHeaders: HeadersInit | undefined;

    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        healthCheckedUrl = url;
        healthHeaders = init?.headers;
        return new Response("ok", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const client = createDaytonaSupervisorClient({
      apiKey: "test-api-key",
      computerToken: "secret-token-123",
      snapshot: "prebuilt",
      pollIntervalMs: 1,
      healthTimeoutMs: 200,
      sdk: sdk as never,
      fetchImpl,
    });

    const url = await client.locate("sales");

    expect(sdk.creates).toHaveLength(1);
    const createParams = sdk.creates[0];
    expect(createParams.snapshot).toBe("prebuilt");
    expect(createParams.public).toBe(true);
    expect(createParams.autoStopInterval).toBe(15);
    expect(createParams.labels).toEqual({
      "openbot/computer": "true",
      "openbot/bot-id": "sales",
    });
    expect(createParams.envVars.COMPUTER_TOKEN).toBe("secret-token-123");
    expect(createParams.envVars.COMPUTER_BOT_ID).toBe("sales");

    expect(url).toBe("https://sb-1.preview.daytona.app");
    expect(healthCheckedUrl).toBe("https://sb-1.preview.daytona.app/health");
    expect(
      new Headers(healthHeaders).get("X-Daytona-Skip-Preview-Warning"),
    ).toBe("true");
  });

  test("stopped labeled sandbox is reused and started", async () => {
    const existing: FakeSandbox = {
      id: "sb-stopped-1",
      state: "stopped",
      labels: {
        "openbot/computer": "true",
        "openbot/bot-id": "support",
      },
      envVars: {
        COMPUTER_TOKEN: "tok",
        COMPUTER_BOT_ID: "support",
      },
      public: true,
      autoStopInterval: 15,
      createdAt: "2026-08-20T10:00:00Z",
      previewUrl: "https://sb-stopped-1.preview.daytona.app",
      startCalls: 0,
      stopCalls: 0,
      deleteCalls: 0,
    };

    const sdk = createFakeSdk([existing]);
    const client = createDaytonaSupervisorClient({
      apiKey: "test-api-key",
      computerToken: "tok",
      snapshot: "prebuilt",
      pollIntervalMs: 1,
      healthTimeoutMs: 200,
      sdk: sdk as never,
      fetchImpl: fakeFetch(),
    });

    const url = await client.locate("support");

    expect(url).toBe("https://sb-stopped-1.preview.daytona.app");
    expect(sdk.creates).toHaveLength(0);
    expect(existing.startCalls).toBe(1);
    expect(existing.state).toBe("started");
  });

  test("concurrent locate calls create once", async () => {
    const sdk = createFakeSdk();
    let createsCount = 0;
    const { promise: gatePromise, resolve: openGate } =
      Promise.withResolvers<void>();
    const origCreate = sdk.create;
    sdk.create = async (params, options) => {
      createsCount++;
      await gatePromise;
      return origCreate(params, options);
    };

    const client = createDaytonaSupervisorClient({
      apiKey: "test-api-key",
      computerToken: "tok",
      snapshot: "prebuilt",
      pollIntervalMs: 1,
      healthTimeoutMs: 200,
      sdk: sdk as never,
      fetchImpl: fakeFetch(),
    });

    const firstLocate = client.locate("marketing");
    const secondLocate = client.locate("marketing");
    openGate();

    const [url1, url2] = await Promise.all([firstLocate, secondLocate]);

    expect(url1).toBe(url2);
    expect(createsCount).toBe(1);
  });

  test("reset deletes and the next locate creates fresh", async () => {
    const sdk = createFakeSdk();
    const client = createDaytonaSupervisorClient({
      apiKey: "test-api-key",
      computerToken: "tok",
      snapshot: "prebuilt",
      pollIntervalMs: 1,
      healthTimeoutMs: 200,
      sdk: sdk as never,
      fetchImpl: fakeFetch(),
    });

    const firstUrl = await client.locate("finance");
    expect(sdk.creates).toHaveLength(1);
    const firstSandbox = sdk.sandboxes.get("sb-1")!;

    await client.reset("finance");
    expect(firstSandbox.deleteCalls).toBe(1);

    const secondUrl = await client.locate("finance");
    expect(sdk.creates).toHaveLength(2);
    expect(secondUrl).not.toBe(firstUrl);
  });

  test("stop with no sandbox is a no-op", async () => {
    const sdk = createFakeSdk();
    const client = createDaytonaSupervisorClient({
      apiKey: "test-api-key",
      computerToken: "tok",
      snapshot: "prebuilt",
      pollIntervalMs: 1,
      healthTimeoutMs: 200,
      sdk: sdk as never,
      fetchImpl: fakeFetch(),
    });

    await expect(client.stop("nonexistent")).resolves.toBeUndefined();
    expect(sdk.creates).toHaveLength(0);
  });

  test("SDK failure throws SupervisorError naming the Bot", async () => {
    const sdk = createFakeSdk();
    sdk.create = async () => {
      throw new Error("quota exceeded");
    };

    const client = createDaytonaSupervisorClient({
      apiKey: "test-api-key",
      computerToken: "tok",
      snapshot: "prebuilt",
      pollIntervalMs: 1,
      healthTimeoutMs: 200,
      sdk: sdk as never,
      fetchImpl: fakeFetch(),
    });

    await expect(client.locate("analytics")).rejects.toThrow(SupervisorError);
    await expect(client.locate("analytics")).rejects.toThrow(/analytics/);
  });

  test("list maps openbot/bot-id and skips destroyed", async () => {
    const activeBot: FakeSandbox = {
      id: "sb-active",
      state: "started",
      labels: {
        "openbot/computer": "true",
        "openbot/bot-id": "bot-active",
      },
      envVars: {},
      public: true,
      autoStopInterval: 15,
      createdAt: "2026-08-20T10:00:00Z",
      previewUrl: "https://sb-active.preview.daytona.app",
      startCalls: 0,
      stopCalls: 0,
      deleteCalls: 0,
    };

    const destroyedBot: FakeSandbox = {
      id: "sb-destroyed",
      state: "destroyed",
      labels: {
        "openbot/computer": "true",
        "openbot/bot-id": "bot-destroyed",
      },
      envVars: {},
      public: true,
      autoStopInterval: 15,
      createdAt: "2026-08-20T09:00:00Z",
      previewUrl: "https://sb-destroyed.preview.daytona.app",
      startCalls: 0,
      stopCalls: 0,
      deleteCalls: 0,
    };

    const stoppedBot: FakeSandbox = {
      id: "sb-stopped",
      state: "stopped",
      labels: {
        "openbot/computer": "true",
        "openbot/bot-id": "bot-stopped",
      },
      envVars: {},
      public: true,
      autoStopInterval: 15,
      createdAt: "2026-08-20T11:00:00Z",
      previewUrl: "https://sb-stopped.preview.daytona.app",
      startCalls: 0,
      stopCalls: 0,
      deleteCalls: 0,
    };

    const unrelatedSandbox: FakeSandbox = {
      id: "sb-unrelated",
      state: "started",
      labels: {
        "some-other-label": "true",
      },
      envVars: {},
      public: true,
      autoStopInterval: 15,
      createdAt: "2026-08-20T08:00:00Z",
      previewUrl: "https://sb-unrelated.preview.daytona.app",
      startCalls: 0,
      stopCalls: 0,
      deleteCalls: 0,
    };

    const sdk = createFakeSdk([
      activeBot,
      destroyedBot,
      stoppedBot,
      unrelatedSandbox,
    ]);
    const client = createDaytonaSupervisorClient({
      apiKey: "test-api-key",
      computerToken: "tok",
      snapshot: "prebuilt",
      pollIntervalMs: 1,
      healthTimeoutMs: 200,
      sdk: sdk as never,
      fetchImpl: fakeFetch(),
    });

    const list = await client.list();

    expect(list).toHaveLength(2);
    expect(list).toEqual(
      expect.arrayContaining([
        {
          botId: "bot-active",
          container: "sb-active",
          status: "started",
          startedAt: "2026-08-20T10:00:00Z",
        },
        {
          botId: "bot-stopped",
          container: "sb-stopped",
          status: "stopped",
          startedAt: "2026-08-20T11:00:00Z",
        },
      ]),
    );
  });

  test("health timeout throws SupervisorError", async () => {
    const sdk = createFakeSdk();
    const failingFetch = (async () => {
      return new Response("service unavailable", { status: 503 });
    }) as unknown as typeof fetch;

    const client = createDaytonaSupervisorClient({
      apiKey: "test-api-key",
      computerToken: "tok",
      snapshot: "prebuilt",
      pollIntervalMs: 1,
      healthTimeoutMs: 50,
      sdk: sdk as never,
      fetchImpl: failingFetch,
    });

    await expect(client.locate("unhealthy-bot")).rejects.toThrow(
      SupervisorError,
    );
    await expect(client.locate("unhealthy-bot")).rejects.toThrow(
      /The computer for unhealthy-bot started but never answered \/health/,
    );
  });

  test("snapshot naming is stable for unchanged temp sources and changes when source contents change", async () => {
    const fixtureDir = mkdtempSync(
      join(tmpdir(), "openbot-agent-computer-test-"),
    );
    tempDirs.push(fixtureDir);

    writeFileSync(
      join(fixtureDir, "package.json"),
      JSON.stringify({ name: "agent-computer", version: "1.0.0" }),
    );
    mkdirSync(join(fixtureDir, "src"), { recursive: true });
    writeFileSync(
      join(fixtureDir, "src", "index.ts"),
      'console.log("hello world");\n',
    );

    const sdk1 = createFakeSdk();
    const client1 = createDaytonaSupervisorClient({
      apiKey: "test-api-key",
      computerToken: "tok",
      agentComputerDir: fixtureDir,
      pollIntervalMs: 1,
      healthTimeoutMs: 200,
      sdk: sdk1 as never,
      fetchImpl: fakeFetch(),
    });

    await client1.locate("bot-1");
    expect(sdk1.creates).toHaveLength(1);
    const snapshotName1 = sdk1.creates[0].snapshot;
    expect(snapshotName1).toMatch(/^openbot-agent-computer-[a-f0-9]{12}$/);

    const sdk2 = createFakeSdk();
    const client2 = createDaytonaSupervisorClient({
      apiKey: "test-api-key",
      computerToken: "tok",
      agentComputerDir: fixtureDir,
      pollIntervalMs: 1,
      healthTimeoutMs: 200,
      sdk: sdk2 as never,
      fetchImpl: fakeFetch(),
    });

    await client2.locate("bot-2");
    expect(sdk2.creates).toHaveLength(1);
    const snapshotName2 = sdk2.creates[0].snapshot;
    expect(snapshotName2).toBe(snapshotName1);

    writeFileSync(
      join(fixtureDir, "src", "index.ts"),
      'console.log("hello world updated");\n',
    );

    const sdk3 = createFakeSdk();
    const client3 = createDaytonaSupervisorClient({
      apiKey: "test-api-key",
      computerToken: "tok",
      agentComputerDir: fixtureDir,
      pollIntervalMs: 1,
      healthTimeoutMs: 200,
      sdk: sdk3 as never,
      fetchImpl: fakeFetch(),
    });

    await client3.locate("bot-3");
    expect(sdk3.creates).toHaveLength(1);
    const snapshotName3 = sdk3.creates[0].snapshot;
    expect(snapshotName3).toMatch(/^openbot-agent-computer-[a-f0-9]{12}$/);
    expect(snapshotName3).not.toBe(snapshotName1);
  });

  test("snapshot image recipe configures PATH with bun and standard system binaries without literal variable substitution", async () => {
    const fixtureDir = mkdtempSync(
      join(tmpdir(), "openbot-agent-computer-test-"),
    );
    tempDirs.push(fixtureDir);

    writeFileSync(
      join(fixtureDir, "package.json"),
      JSON.stringify({ name: "agent-computer", version: "1.0.0" }),
    );
    mkdirSync(join(fixtureDir, "src"), { recursive: true });
    writeFileSync(
      join(fixtureDir, "src", "index.ts"),
      'console.log("hello world");\n',
    );

    let capturedImage: { dockerfile: string } | undefined;
    const sdk = createFakeSdk();
    const originalSnapshotCreate = sdk.snapshot.create;
    sdk.snapshot.create = async (params, options) => {
      capturedImage = params.image as { dockerfile: string };
      return originalSnapshotCreate(params, options);
    };

    const client = createDaytonaSupervisorClient({
      apiKey: "test-api-key",
      computerToken: "tok",
      agentComputerDir: fixtureDir,
      pollIntervalMs: 1,
      healthTimeoutMs: 200,
      sdk: sdk as never,
      fetchImpl: fakeFetch(),
    });

    await client.locate("recipe-test-bot");

    expect(capturedImage).toBeDefined();
    const dockerfile = capturedImage!.dockerfile;

    const envPathLine = dockerfile
      .split("\n")
      .find((line) => line.startsWith("ENV PATH="));

    expect(envPathLine).toBeDefined();
    expect(envPathLine).toContain("/root/.bun/bin");
    expect(envPathLine).toContain("/usr/bin");
    expect(envPathLine).toContain("/bin");
    expect(envPathLine).not.toContain("${PATH}");
    expect(dockerfile).not.toContain("${PATH}");
  });

  test("reset waits for sandbox deletion so list does not return the reset bot", async () => {
    const existing: FakeSandbox = {
      id: "sb-reset-wait-1",
      state: "started",
      labels: {
        "openbot/computer": "true",
        "openbot/bot-id": "reset-wait-bot",
      },
      envVars: {},
      public: true,
      autoStopInterval: 15,
      createdAt: "2026-08-20T10:00:00Z",
      previewUrl: "https://sb-reset-wait-1.preview.daytona.app",
      startCalls: 0,
      stopCalls: 0,
      deleteCalls: 0,
      deleteHandler: (_timeout, wait) => {
        if (wait) {
          existing.state = "destroyed";
        }
      },
    };

    const sdk = createFakeSdk([existing]);
    const client = createDaytonaSupervisorClient({
      apiKey: "test-api-key",
      computerToken: "tok",
      snapshot: "prebuilt",
      pollIntervalMs: 1,
      healthTimeoutMs: 200,
      sdk: sdk as never,
      fetchImpl: fakeFetch(),
    });

    await client.reset("reset-wait-bot");

    const remaining = await client.list();
    expect(
      remaining.find((bot) => bot.botId === "reset-wait-bot"),
    ).toBeUndefined();
  });

  test("reset waits for Daytona list convergence across eventual consistency stale started responses", async () => {
    const existing: FakeSandbox = {
      id: "sb-reset-convergence-1",
      state: "started",
      labels: {
        "openbot/computer": "true",
        "openbot/bot-id": "reset-convergence-bot",
      },
      envVars: {},
      public: true,
      autoStopInterval: 15,
      createdAt: "2026-08-20T10:00:00Z",
      previewUrl: "https://sb-reset-convergence-1.preview.daytona.app",
      startCalls: 0,
      stopCalls: 0,
      deleteCalls: 0,
    };

    const sdk = createFakeSdk([existing]);
    let postDeleteListCalls = 0;
    const origList = sdk.list;

    sdk.list = (query?: { labels?: Record<string, string> }) => {
      if (existing.deleteCalls > 0) {
        postDeleteListCalls++;
        if (postDeleteListCalls === 2) {
          async function* staleGenerator() {
            yield {
              id: existing.id,
              state: "started",
              labels: existing.labels,
              createdAt: existing.createdAt,
              start: async () => {},
              stop: async () => {},
              delete: async () => {},
              getPreviewLink: async () => ({ url: existing.previewUrl }),
            };
          }
          return staleGenerator();
        }
        async function* emptyGenerator() {}
        return emptyGenerator();
      }
      return origList(query);
    };

    const client = createDaytonaSupervisorClient({
      apiKey: "test-api-key",
      computerToken: "tok",
      snapshot: "prebuilt",
      pollIntervalMs: 1,
      healthTimeoutMs: 200,
      sdk: sdk as never,
      fetchImpl: fakeFetch(),
    });

    await client.reset("reset-convergence-bot");

    const immediate = await client.list();
    expect(
      immediate.find((bot) => bot.botId === "reset-convergence-bot"),
    ).toBeUndefined();

    const later = await client.list();
    expect(
      later.find((bot) => bot.botId === "reset-convergence-bot"),
    ).toBeUndefined();

    expect(postDeleteListCalls).toBeGreaterThanOrEqual(3);
  });
});
