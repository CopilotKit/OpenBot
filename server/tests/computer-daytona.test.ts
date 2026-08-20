import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDaytonaComputerProvider,
  createDaytonaSupervisorClient,
  type DaytonaSdk,
  type DaytonaSupervisorOptions,
  type SandboxHandle,
} from "../src/computer/daytona";
import { ProviderError } from "../src/computer/provider";

/**
 * Daytona computer provider test suite.
 *
 * OpenBot gives each Bot a remote Daytona sandbox when DAYTONA_API_KEY is set.
 * The provider creates, locates, stops, resets, and lists these sandboxes through
 * the Daytona SDK. It checks the preview URL before it returns a computer address.
 */

class DaytonaNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaytonaNotFoundError";
  }
}

type DeleteCall = {
  timeout?: number;
  wait?: boolean;
};

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
  deleteArgs: DeleteCall[];
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

function makeSandbox(options: {
  id: string;
  botId?: string;
  state?: string;
  labels?: Record<string, string>;
  envVars?: Record<string, string>;
  public?: boolean;
  autoStopInterval?: number;
  createdAt?: string;
  previewUrl?: string;
  deleteHandler?: (timeout?: number, wait?: boolean) => void | Promise<void>;
}): FakeSandbox {
  const botId = options.botId;
  const defaultLabels = botId
    ? { "openbot/computer": "true", "openbot/bot-id": botId }
    : { "openbot/computer": "true" };
  const labels = options.labels ?? defaultLabels;
  const envVars =
    options.envVars ??
    (botId ? { COMPUTER_TOKEN: "tok", COMPUTER_BOT_ID: botId } : {});

  return {
    id: options.id,
    state: options.state ?? "started",
    labels,
    envVars,
    public: options.public ?? true,
    autoStopInterval: options.autoStopInterval ?? 15,
    createdAt: options.createdAt ?? "2026-08-20T10:00:00Z",
    previewUrl:
      options.previewUrl ?? `https://${options.id}.preview.daytona.app`,
    startCalls: 0,
    stopCalls: 0,
    deleteCalls: 0,
    deleteArgs: [],
    ...(options.deleteHandler ? { deleteHandler: options.deleteHandler } : {}),
  };
}

function makeSandboxHandle(sb: FakeSandbox): SandboxHandle {
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
      sb.deleteArgs.push({ timeout, wait });
      if (sb.deleteHandler) {
        await sb.deleteHandler(timeout, wait);
      } else {
        sb.state = "destroyed";
      }
    },
    getPreviewLink: async (_port: number) => ({ url: sb.previewUrl }),
  };
}

type FakeSdk = DaytonaSdk & {
  sandboxes: Map<string, FakeSandbox>;
  snapshots: Map<string, { state: string }>;
  creates: CreateParams[];
};

function createFakeSdk(initialSandboxes: FakeSandbox[] = []): FakeSdk {
  let idCounter = 1;
  const sandboxes = new Map<string, FakeSandbox>();
  const snapshots = new Map<string, { state: string }>();
  const creates: CreateParams[] = [];

  for (const sb of initialSandboxes) {
    sandboxes.set(sb.id, sb);
  }

  const sdk: FakeSdk = {
    sandboxes,
    snapshots,
    creates,
    create: async (params, options) => {
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
        deleteArgs: [],
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
      create: async (params, _options) => {
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

type ClientOverrides = Partial<DaytonaSupervisorOptions> & {
  snapshotTimeoutMs?: number;
};

function makeClient(
  sdk: FakeSdk = createFakeSdk(),
  overrides: ClientOverrides = {},
) {
  const defaultSnapshot =
    !overrides.agentComputerDir && overrides.snapshot === undefined
      ? { snapshot: "prebuilt" }
      : {};
  return createDaytonaSupervisorClient({
    apiKey: "test-api-key",
    computerToken: "tok",
    pollIntervalMs: 1,
    healthTimeoutMs: 200,
    sdk,
    fetchImpl: fakeFetch(),
    ...defaultSnapshot,
    ...overrides,
  } as DaytonaSupervisorOptions);
}

describe("Daytona computer supervisor", () => {
  const tempDirs: string[] = [];

  test("exposes the Daytona per-Bot provider contract", () => {
    const provider = createDaytonaComputerProvider({
      apiKey: "test-api-key",
      computerToken: "tok",
      snapshot: "prebuilt",
      sdk: createFakeSdk(),
      fetchImpl: fakeFetch(),
    });

    expect(provider.name).toBe("Daytona");
    expect(provider.isolation).toBe("per-bot");
    expect(provider.describeIsolation()).toEqual({
      isolation: "one computer per Bot",
      note: "Each Bot gets a remote Daytona sandbox with its own /workspace and its own browser profile.",
    });
  });

  test("status maps Daytona lifecycle states without starting or creating a sandbox", async () => {
    const states = {
      readyStarted: "started",
      readyRunning: "running",
      startingCreated: "created",
      startingRestarting: "restarting",
      startingCreating: "creating",
      startingStarting: "starting",
      startingRestoring: "restoring",
      startingPulling: "pulling_snapshot",
      startingResuming: "resuming",
      absentStopped: "stopped",
      absentPaused: "paused",
      absentArchived: "archived",
      absentExited: "exited",
      absentDestroyed: "destroyed",
      absentRemoving: "removing",
      absentArchiving: "archiving",
      absentPausing: "pausing",
      absentStopping: "stopping",
      unreachableError: "error",
      unreachableBuildFailed: "build_failed",
      unreachableUnknown: "new_state",
    } as const;
    const sandboxes = Object.entries(states).map(([botId, state], index) =>
      makeSandbox({ id: `status-${index}`, botId, state }),
    );
    const sdk = createFakeSdk(sandboxes);
    const provider = makeClient(sdk);

    for (const [botId, state] of Object.entries(states)) {
      const status = await provider.status(botId);
      if (state === "started" || state === "running") {
        expect(status).toEqual({ botId, state: "ready" });
      } else if (
        [
          "created",
          "restarting",
          "creating",
          "starting",
          "restoring",
          "pulling_snapshot",
          "resuming",
        ].includes(state)
      ) {
        expect(status).toEqual({ botId, state: "starting" });
      } else if (
        [
          "stopped",
          "paused",
          "archived",
          "exited",
          "destroyed",
          "removing",
          "archiving",
          "pausing",
          "stopping",
        ].includes(state)
      ) {
        expect(status).toEqual({ botId, state: "absent" });
      } else {
        expect(status).toMatchObject({
          botId,
          state: "unreachable",
          reason: expect.any(String),
        });
      }
    }
    expect(sdk.creates).toHaveLength(0);
    expect(sandboxes.every((sandbox) => sandbox.startCalls === 0)).toBe(true);
  });

  test("status reports an unknown Bot as absent without preparing the snapshot", async () => {
    const sdk = createFakeSdk();
    sdk.snapshot.get = async () => {
      throw new Error("status must not inspect the snapshot");
    };
    const provider = createDaytonaComputerProvider({
      apiKey: "test-api-key",
      computerToken: "tok",
      sdk,
      fetchImpl: fakeFetch(),
    });

    await expect(provider.status("missing-bot")).resolves.toEqual({
      botId: "missing-bot",
      state: "absent",
    });
    expect(sdk.creates).toHaveLength(0);
  });
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

    const fetchImpl = fakeFetch((url, init) => {
      if (url.endsWith("/health")) {
        healthCheckedUrl = url;
        healthHeaders = init?.headers;
        return new Response("ok", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const client = makeClient(sdk, {
      computerToken: "secret-token-123",
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
    const existing = makeSandbox({
      id: "sb-stopped-1",
      botId: "support",
      state: "stopped",
    });

    const sdk = createFakeSdk([existing]);
    const client = makeClient(sdk);

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

    const client = makeClient(sdk);

    const firstLocate = client.locate("marketing");
    const secondLocate = client.locate("marketing");
    openGate();

    const [url1, url2] = await Promise.all([firstLocate, secondLocate]);

    expect(url1).toBe(url2);
    expect(createsCount).toBe(1);
  });

  test("reset deletes and the next locate creates fresh", async () => {
    const sdk = createFakeSdk();
    const client = makeClient(sdk);

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
    const client = makeClient(sdk);

    await expect(client.stop("nonexistent")).resolves.toBeUndefined();
    expect(sdk.creates).toHaveLength(0);
  });

  test("SDK failure throws ProviderError naming the Bot", async () => {
    const sdk = createFakeSdk();
    sdk.create = async () => {
      throw new Error("quota exceeded");
    };

    const client = makeClient(sdk);

    await expect(client.locate("analytics")).rejects.toThrow(ProviderError);
    await expect(client.locate("analytics")).rejects.toThrow(/analytics/);
  });

  test("list maps openbot/bot-id and skips destroyed", async () => {
    const activeBot = makeSandbox({
      id: "sb-active",
      botId: "bot-active",
      state: "started",
      createdAt: "2026-08-20T10:00:00Z",
    });

    const destroyedBot = makeSandbox({
      id: "sb-destroyed",
      botId: "bot-destroyed",
      state: "destroyed",
      createdAt: "2026-08-20T09:00:00Z",
    });

    const stoppedBot = makeSandbox({
      id: "sb-stopped",
      botId: "bot-stopped",
      state: "stopped",
      createdAt: "2026-08-20T11:00:00Z",
    });

    const unrelatedSandbox = makeSandbox({
      id: "sb-unrelated",
      labels: {
        "some-other-label": "true",
      },
      createdAt: "2026-08-20T08:00:00Z",
    });

    const sdk = createFakeSdk([
      activeBot,
      destroyedBot,
      stoppedBot,
      unrelatedSandbox,
    ]);
    const client = makeClient(sdk);

    const list = await client.list();

    expect(list).toHaveLength(2);
    expect(list).toEqual(
      expect.arrayContaining([
        {
          botId: "bot-active",
          status: "running",
          url: "https://sb-active.preview.daytona.app",
          startedAt: "2026-08-20T10:00:00Z",
        },
        {
          botId: "bot-stopped",
          status: "exited",
          url: "https://sb-stopped.preview.daytona.app",
          startedAt: "2026-08-20T11:00:00Z",
        },
      ]),
    );
  });

  test("health timeout throws ProviderError", async () => {
    const sdk = createFakeSdk();
    const failingFetch = fakeFetch(
      () => new Response("service unavailable", { status: 503 }),
    );

    const client = makeClient(sdk, {
      healthTimeoutMs: 50,
      fetchImpl: failingFetch,
    });

    await expect(client.locate("unhealthy-bot")).rejects.toThrow(
      ProviderError,
    );
    await expect(client.locate("unhealthy-bot")).rejects.toThrow(
      /The computer for unhealthy-bot started but never answered \/health/,
    );
  });

  test("health fetch that never resolves is bounded by healthTimeoutMs and locate rejects with ProviderError", async () => {
    const sdk = createFakeSdk();
    const hangingFetch = fakeFetch(() => {
      const { promise } = Promise.withResolvers<Response>();
      return promise;
    });

    const client = makeClient(sdk, {
      healthTimeoutMs: 30,
      fetchImpl: hangingFetch,
    });

    let locateError: unknown;
    try {
      await client.locate("hanging-health-bot");
    } catch (err) {
      locateError = err;
    }

    expect(locateError).toBeInstanceOf(ProviderError);
    expect((locateError as Error)?.message).toContain(
      "The computer for hanging-health-bot started but never answered /health at its preview URL.",
    );
  });

  test("snapshot.create that never resolves is bounded by snapshotTimeoutMs and locate rejects with ProviderError", async () => {
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
      'console.log("agent-computer");\n',
    );

    const sdk = createFakeSdk();
    sdk.snapshot.create = () => {
      const { promise } = Promise.withResolvers<unknown>();
      return promise;
    };

    const client = makeClient(sdk, {
      agentComputerDir: fixtureDir,
      snapshotTimeoutMs: 30,
    });

    let locateError: unknown;
    try {
      await client.locate("hanging-snapshot-bot");
    } catch (err) {
      locateError = err;
    }

    expect(locateError).toBeInstanceOf(ProviderError);
  });

  test("missing agentComputerDir package.json or src directory rejects locate with ProviderError naming the directory and advising DAYTONA_SNAPSHOT", async () => {
    const missingPkgDir = mkdtempSync(
      join(tmpdir(), "openbot-missing-pkg-test-"),
    );
    tempDirs.push(missingPkgDir);
    mkdirSync(join(missingPkgDir, "src"), { recursive: true });
    writeFileSync(
      join(missingPkgDir, "src", "index.ts"),
      'console.log("agent-computer");\n',
    );

    const clientMissingPkg = makeClient(createFakeSdk(), {
      agentComputerDir: missingPkgDir,
      healthTimeoutMs: 50,
    });

    let pkgError: unknown;
    try {
      await clientMissingPkg.locate("missing-pkg-bot");
    } catch (err) {
      pkgError = err;
    }

    expect(pkgError).toBeInstanceOf(ProviderError);
    expect((pkgError as Error)?.message).toContain(missingPkgDir);
    expect((pkgError as Error)?.message).toContain("DAYTONA_SNAPSHOT");

    const missingSrcDir = mkdtempSync(
      join(tmpdir(), "openbot-missing-src-test-"),
    );
    tempDirs.push(missingSrcDir);
    writeFileSync(
      join(missingSrcDir, "package.json"),
      JSON.stringify({ name: "agent-computer", version: "1.0.0" }),
    );

    const clientMissingSrc = makeClient(createFakeSdk(), {
      agentComputerDir: missingSrcDir,
      healthTimeoutMs: 50,
    });

    let srcError: unknown;
    try {
      await clientMissingSrc.locate("missing-src-bot");
    } catch (err) {
      srcError = err;
    }

    expect(srcError).toBeInstanceOf(ProviderError);
    expect((srcError as Error)?.message).toContain(missingSrcDir);
    expect((srcError as Error)?.message).toContain("DAYTONA_SNAPSHOT");
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
    const client1 = makeClient(sdk1, { agentComputerDir: fixtureDir });

    await client1.locate("bot-1");
    expect(sdk1.creates).toHaveLength(1);
    const snapshotName1 = sdk1.creates[0].snapshot;
    expect(snapshotName1).toMatch(/^openbot-agent-computer-[a-f0-9]{12}$/);

    const sdk2 = createFakeSdk();
    const client2 = makeClient(sdk2, { agentComputerDir: fixtureDir });

    await client2.locate("bot-2");
    expect(sdk2.creates).toHaveLength(1);
    const snapshotName2 = sdk2.creates[0].snapshot;
    expect(snapshotName2).toBe(snapshotName1);

    writeFileSync(
      join(fixtureDir, "src", "index.ts"),
      'console.log("hello world updated");\n',
    );

    const sdk3 = createFakeSdk();
    const client3 = makeClient(sdk3, { agentComputerDir: fixtureDir });

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

    const client = makeClient(sdk, { agentComputerDir: fixtureDir });

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
    const existing = makeSandbox({
      id: "sb-reset-wait-1",
      botId: "reset-wait-bot",
      deleteHandler: (_timeout, wait) => {
        if (wait) {
          existing.state = "destroyed";
        }
      },
    });

    const sdk = createFakeSdk([existing]);
    const client = makeClient(sdk);

    await client.reset("reset-wait-bot");

    expect(existing.deleteCalls).toBe(1);
    expect(existing.deleteArgs).toEqual([{ timeout: 60, wait: true }]);
    const remaining = await client.list();
    expect(
      remaining.find((bot) => bot.botId === "reset-wait-bot"),
    ).toBeUndefined();
  });

  test("reset waits for Daytona list convergence across eventual consistency stale started responses", async () => {
    const existing = makeSandbox({
      id: "sb-reset-convergence-1",
      botId: "reset-convergence-bot",
    });

    const sdk = createFakeSdk([existing]);
    let postDeleteListCalls = 0;
    const origList = sdk.list;

    sdk.list = (query?: { labels?: Record<string, string> }) => {
      if (existing.deleteCalls > 0) {
        postDeleteListCalls++;
        if (postDeleteListCalls === 1) {
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

    const client = makeClient(sdk);

    await client.reset("reset-convergence-bot");

    const immediate = await client.list();
    expect(
      immediate.find((bot) => bot.botId === "reset-convergence-bot"),
    ).toBeUndefined();

    const later = await client.list();
    expect(
      later.find((bot) => bot.botId === "reset-convergence-bot"),
    ).toBeUndefined();
  });

  test("failed reset deletion does not tombstone sandbox so retry deletes it and removes it from list", async () => {
    let deleteAttempts = 0;
    const existing = makeSandbox({
      id: "sb-failed-delete-1",
      botId: "retry-delete-bot",
      deleteHandler: (_timeout, _wait) => {
        deleteAttempts++;
        if (deleteAttempts === 1) {
          throw new Error("transient deletion error");
        }
        existing.state = "destroyed";
      },
    });

    const sdk = createFakeSdk([existing]);
    const client = makeClient(sdk);

    let resetError: unknown;
    try {
      await client.reset("retry-delete-bot");
    } catch (err) {
      resetError = err;
    }

    expect(resetError).toBeInstanceOf(ProviderError);
    expect((resetError as Error)?.message).toContain("retry-delete-bot");
    expect(existing.deleteCalls).toBe(1);

    await client.reset("retry-delete-bot");

    expect(existing.deleteCalls).toBe(2);
    const remaining = await client.list();
    expect(
      remaining.find((bot) => bot.botId === "retry-delete-bot"),
    ).toBeUndefined();
  });

  test("locate polls stopping sandbox until stopped, calls start(300), and returns preview URL after healthy /health", async () => {
    const stoppingSandbox = makeSandbox({
      id: "sb-stopping-1",
      botId: "stopping-bot",
      state: "stopping",
    });

    const sdk = createFakeSdk([stoppingSandbox]);
    let getCalls = 0;
    const origGet = sdk.get;
    sdk.get = async (id: string) => {
      if (id === stoppingSandbox.id && ++getCalls === 1) {
        stoppingSandbox.state = "stopped";
      }
      return origGet(id);
    };

    const client = makeClient(sdk);

    const url = await client.locate("stopping-bot");

    expect(url).toBe("https://sb-stopping-1.preview.daytona.app");
    expect(stoppingSandbox.startCalls).toBe(1);
    expect(stoppingSandbox.state).toBe("started");
  });

  test("locate creates a fresh sandbox when a cached sandbox is destroying or not found", async () => {
    const sdk = createFakeSdk();
    const client = makeClient(sdk);

    const firstUrl = await client.locate("destroying-bot");
    expect(sdk.creates).toHaveLength(1);
    expect(firstUrl).toBe("https://sb-1.preview.daytona.app");

    const firstSandbox = sdk.sandboxes.get("sb-1")!;
    firstSandbox.state = "destroying";

    const secondUrl = await client.locate("destroying-bot");
    expect(sdk.creates).toHaveLength(2);
    expect(secondUrl).toBe("https://sb-2.preview.daytona.app");
    expect(secondUrl).not.toBe(firstUrl);
  });

  test("stop on an already stopped sandbox resolves without calling sandbox.stop", async () => {
    const stoppedSandbox = makeSandbox({
      id: "sb-already-stopped",
      botId: "already-stopped-bot",
      state: "stopped",
    });

    const sdk = createFakeSdk([stoppedSandbox]);
    const client = makeClient(sdk);

    await client.stop("already-stopped-bot");

    expect(stoppedSandbox.stopCalls).toBe(0);
  });

  test("list maps Daytona started to running and stopped to exited in shared supervisor vocabulary", async () => {
    const startedSandbox = makeSandbox({
      id: "sb-started-voc",
      botId: "started-voc-bot",
      state: "started",
      createdAt: "2026-08-20T10:00:00Z",
    });

    const stoppedSandbox = makeSandbox({
      id: "sb-stopped-voc",
      botId: "stopped-voc-bot",
      state: "stopped",
      createdAt: "2026-08-20T11:00:00Z",
    });

    const sdk = createFakeSdk([startedSandbox, stoppedSandbox]);
    const client = makeClient(sdk);

    const list = await client.list();

    expect(list).toEqual(
      expect.arrayContaining([
        {
          botId: "started-voc-bot",
          status: "running",
          url: "https://sb-started-voc.preview.daytona.app",
          startedAt: "2026-08-20T10:00:00Z",
        },
        {
          botId: "stopped-voc-bot",
          status: "exited",
          url: "https://sb-stopped-voc.preview.daytona.app",
          startedAt: "2026-08-20T11:00:00Z",
        },
      ]),
    );
  });
});
