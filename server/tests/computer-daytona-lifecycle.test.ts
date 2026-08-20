import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ProviderError } from "../src/computer/provider";
import {
  createFakeSdk,
  fakeFetch,
  makeClient,
  makeSandbox,
} from "./computer-daytona-fixture";

describe("Daytona computer lifecycle supervisor", () => {
  test("create carries snapshot, ownership labels including token hash, public:true, autoStopInterval:15, COMPUTER_TOKEN and COMPUTER_BOT_ID then returns preview URL after healthy /health", async () => {
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

    const token = "secret-token-123";
    const expectedHash = createHash("sha256").update(token).digest("hex");

    const client = makeClient(sdk, {
      computerToken: token,
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
      "openbot/computer-token-hash": expectedHash,
    });
    expect(createParams.envVars.COMPUTER_TOKEN).toBe(token);
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

  test("locate on a reusable started sandbox calls refreshActivity exactly once before returning", async () => {
    const token = "tok";
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const startedSandbox = makeSandbox({
      id: "sb-started-activity",
      botId: "activity-bot",
      state: "started",
      labels: {
        "openbot/computer": "true",
        "openbot/bot-id": "activity-bot",
        "openbot/computer-token-hash": tokenHash,
      },
    });

    const sdk = createFakeSdk([startedSandbox]);
    const client = makeClient(sdk, { computerToken: token });

    const url = await client.locate("activity-bot");

    expect(url).toBe("https://sb-started-activity.preview.daytona.app");
    expect(startedSandbox.refreshActivityCalls).toBe(1);
    expect(startedSandbox.startCalls).toBe(0);
    expect(sdk.creates).toHaveLength(0);
  });

  test("existing sandbox with stale openbot/computer-token-hash is deleted and replaced with correct fingerprint label", async () => {
    const currentToken = "rotated-secret-456";
    const expectedHash = createHash("sha256")
      .update(currentToken)
      .digest("hex");

    const staleSandbox = makeSandbox({
      id: "sb-stale-token",
      botId: "rotate-bot",
      labels: {
        "openbot/computer": "true",
        "openbot/bot-id": "rotate-bot",
        "openbot/computer-token-hash": "outdated-sha256-hash",
      },
    });

    const sdk = createFakeSdk([staleSandbox]);
    const client = makeClient(sdk, {
      computerToken: currentToken,
    });

    const url = await client.locate("rotate-bot");

    expect(staleSandbox.deleteCalls).toBe(1);
    expect(sdk.creates).toHaveLength(1);
    const createParams = sdk.creates[0];
    expect(createParams.labels).toEqual({
      "openbot/computer": "true",
      "openbot/bot-id": "rotate-bot",
      "openbot/computer-token-hash": expectedHash,
    });
    expect(createParams.envVars.COMPUTER_TOKEN).toBe(currentToken);
    expect(url).toBe("https://sb-1.preview.daytona.app");
  });

  test("existing sandbox with missing openbot/computer-token-hash label is deleted and replaced", async () => {
    const currentToken = "active-token";
    const expectedHash = createHash("sha256")
      .update(currentToken)
      .digest("hex");

    const legacySandbox = makeSandbox({
      id: "sb-legacy-token",
      botId: "legacy-bot",
      labels: {
        "openbot/computer": "true",
        "openbot/bot-id": "legacy-bot",
      },
    });

    const sdk = createFakeSdk([legacySandbox]);
    const client = makeClient(sdk, {
      computerToken: currentToken,
    });

    const url = await client.locate("legacy-bot");

    expect(legacySandbox.deleteCalls).toBe(1);
    expect(sdk.creates).toHaveLength(1);
    expect(sdk.creates[0].labels["openbot/computer-token-hash"]).toBe(
      expectedHash,
    );
    expect(url).toBe("https://sb-1.preview.daytona.app");
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

  test("concurrent resets for the same Bot serialize, delete at most once, and both resolve", async () => {
    let deleteCalls = 0;
    const { promise: deleteGate, resolve: releaseDelete } =
      Promise.withResolvers<void>();

    const existing = makeSandbox({
      id: "sb-concurrent-reset",
      botId: "concurrent-bot",
      deleteHandler: async () => {
        deleteCalls++;
        if (deleteCalls > 1) {
          throw new Error("Daytona conflict: sandbox is already being deleted");
        }
        await deleteGate;
        existing.state = "destroyed";
      },
    });

    const sdk = createFakeSdk([existing]);
    const client = makeClient(sdk);

    const firstReset = client.reset("concurrent-bot");
    const secondReset = client.reset("concurrent-bot");

    releaseDelete();
    const [res1, res2] = await Promise.all([firstReset, secondReset]);

    expect(existing.deleteCalls).toBe(1);
    expect(res1).toEqual({ cleared: true });
    expect(res2).toEqual({ cleared: false });
    const list = await client.list();
    expect(list.find((b) => b.botId === "concurrent-bot")).toBeUndefined();
    expect(list).toHaveLength(0);
  });

  test("locate started during reset waits for reset completion, never health-polls the old sandbox, and returns a new sandbox", async () => {
    const fetchedUrls: string[] = [];
    const { promise: resetBlocker, resolve: unblockReset } =
      Promise.withResolvers<void>();

    const oldSandbox = makeSandbox({
      id: "sb-old",
      botId: "race-bot",
      previewUrl: "https://sb-old.preview.daytona.app",
      deleteHandler: async () => {
        await resetBlocker;
        oldSandbox.state = "destroyed";
      },
    });

    const sdk = createFakeSdk([oldSandbox]);
    const fetchImpl = fakeFetch((url) => {
      fetchedUrls.push(url);
      if (url === "https://sb-old.preview.daytona.app/health") {
        throw new Error("poll attempted against deleted sandbox preview URL");
      }
      if (url === "https://sb-1.preview.daytona.app/health") {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const client = makeClient(sdk, { fetchImpl });

    const resetPromise = client.reset("race-bot");
    const locatePromise = client.locate("race-bot");

    unblockReset();
    const [resetResult, newUrl] = await Promise.all([
      resetPromise,
      locatePromise,
    ]);

    expect(resetResult).toEqual({ cleared: true });
    expect(oldSandbox.deleteCalls).toBe(1);
    expect(newUrl).toBe("https://sb-1.preview.daytona.app");
    expect(sdk.creates).toHaveLength(1);
    expect(fetchedUrls).toEqual(["https://sb-1.preview.daytona.app/health"]);
    expect(fetchedUrls).not.toContain(
      "https://sb-old.preview.daytona.app/health",
    );
  });

  test("reset deletes and the next locate creates fresh", async () => {
    const sdk = createFakeSdk();
    const client = makeClient(sdk);

    const firstUrl = await client.locate("finance");
    expect(sdk.creates).toHaveLength(1);
    const firstSandbox = sdk.sandboxes.get("sb-1");
    expect(firstSandbox).toBeDefined();
    if (!firstSandbox) {
      throw new Error("firstSandbox must be defined");
    }

    const resetResult = await client.reset("finance");
    expect(resetResult).toEqual({ cleared: true });
    expect(firstSandbox.deleteCalls).toBe(1);

    const secondUrl = await client.locate("finance");
    expect(sdk.creates).toHaveLength(2);
    expect(secondUrl).not.toBe(firstUrl);
  });

  test("reset with no existing sandbox returns cleared false", async () => {
    const sdk = createFakeSdk();
    const client = makeClient(sdk);

    const result = await client.reset("nonexistent");
    expect(result).toEqual({ cleared: false });
  });

  test("stop on a started sandbox calls sandbox.stop and returns wasRunning true", async () => {
    const runningSandbox = makeSandbox({
      id: "sb-running",
      botId: "running-bot",
      state: "started",
    });

    const sdk = createFakeSdk([runningSandbox]);
    const client = makeClient(sdk);

    const result = await client.stop("running-bot");

    expect(result).toEqual({ wasRunning: true });
    expect(runningSandbox.stopCalls).toBe(1);
  });

  test("stop on an already stopped sandbox resolves with wasRunning false without calling sandbox.stop", async () => {
    const stoppedSandbox = makeSandbox({
      id: "sb-already-stopped",
      botId: "already-stopped-bot",
      state: "stopped",
    });

    const sdk = createFakeSdk([stoppedSandbox]);
    const client = makeClient(sdk);

    const result = await client.stop("already-stopped-bot");

    expect(result).toEqual({ wasRunning: false });
    expect(stoppedSandbox.stopCalls).toBe(0);
  });

  test("stop with no sandbox returns wasRunning false", async () => {
    const sdk = createFakeSdk();
    const client = makeClient(sdk);

    await expect(client.stop("nonexistent")).resolves.toEqual({
      wasRunning: false,
    });
    expect(sdk.creates).toHaveLength(0);
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
          status: "stopped",
          url: "https://sb-stopped.preview.daytona.app",
          startedAt: "2026-08-20T11:00:00Z",
        },
      ]),
    );
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

    const result = await client.reset("reset-wait-bot");
    expect(result).toEqual({ cleared: true });

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
              refreshActivity: async () => {},
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

    const result = await client.reset("reset-convergence-bot");
    expect(result).toEqual({ cleared: true });

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

    const retryResult = await client.reset("retry-delete-bot");
    expect(retryResult).toEqual({ cleared: true });

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

    const firstSandbox = sdk.sandboxes.get("sb-1");
    expect(firstSandbox).toBeDefined();
    if (!firstSandbox) {
      throw new Error("firstSandbox must be defined");
    }
    firstSandbox.state = "destroying";

    const secondUrl = await client.locate("destroying-bot");
    expect(sdk.creates).toHaveLength(2);
    expect(secondUrl).toBe("https://sb-2.preview.daytona.app");
    expect(secondUrl).not.toBe(firstUrl);
  });
});
