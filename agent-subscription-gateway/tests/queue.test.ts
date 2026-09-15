import { describe, expect, test } from "bun:test";
import {
  BoundedRunQueue,
  CapacityError,
  HostSemaphore,
  RunDisconnectedError,
} from "../src/runs/queue";
import { RunStore } from "../src/storage/run-store";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("bounded run admission", () => {
  test("runs one request, queues one request, and rejects excess capacity", async () => {
    const queue = new BoundedRunQueue({
      provider: "codex",
      host: new HostSemaphore(1),
      concurrency: 1,
      pendingLimit: 1,
    });
    const first = deferred<string>();
    const order: string[] = [];

    const firstResult = queue.enqueue({
      runId: "run-1",
      signal: new AbortController().signal,
      run: async () => {
        order.push("run-1");
        return first.promise;
      },
    });
    const secondResult = queue.enqueue({
      runId: "run-2",
      signal: new AbortController().signal,
      run: async () => {
        order.push("run-2");
        return "second";
      },
    });

    expect(() =>
      queue.enqueue({
        runId: "run-3",
        signal: new AbortController().signal,
        run: async () => "third",
      }),
    ).toThrow(CapacityError);
    try {
      queue.enqueue({
        runId: "run-4",
        signal: new AbortController().signal,
        run: async () => "fourth",
      });
    } catch (error) {
      expect(error).toMatchObject({ retryable: true });
    }
    expect(queue.snapshot()).toEqual({ activeRuns: 1, queueDepth: 1 });

    first.resolve("first");
    expect(await firstResult).toBe("first");
    expect(await secondResult).toBe("second");
    expect(order).toEqual(["run-1", "run-2"]);
    expect(queue.snapshot()).toEqual({ activeRuns: 0, queueDepth: 0 });
  });

  test("shares one host slot across provider queues", async () => {
    const host = new HostSemaphore(1);
    const codex = new BoundedRunQueue({ provider: "codex", host });
    const claude = new BoundedRunQueue({ provider: "claude", host });
    const gate = deferred<void>();
    const started: string[] = [];

    const codexRun = codex.enqueue({
      runId: "codex-1",
      signal: new AbortController().signal,
      run: async () => {
        started.push("codex");
        await gate.promise;
      },
    });
    const claudeRun = claude.enqueue({
      runId: "claude-1",
      signal: new AbortController().signal,
      run: async () => {
        started.push("claude");
      },
    });

    await Promise.resolve();
    expect(started).toEqual(["codex"]);
    expect(host.activeCount).toBe(1);
    expect(claude.snapshot()).toEqual({ activeRuns: 0, queueDepth: 1 });

    gate.resolve();
    await Promise.all([codexRun, claudeRun]);
    expect(started).toEqual(["codex", "claude"]);
    expect(host.activeCount).toBe(0);
  });

  test("heartbeats only while queued and drops a disconnected request", async () => {
    const host = new HostSemaphore(1);
    const releaseHost = host.tryAcquire();
    expect(releaseHost).toBeDefined();
    const queue = new BoundedRunQueue({
      provider: "grok",
      host,
      heartbeatMs: 5,
    });
    const controller = new AbortController();
    let heartbeats = 0;
    let ran = false;

    const result = queue.enqueue({
      runId: "grok-1",
      signal: controller.signal,
      onHeartbeat: () => {
        heartbeats += 1;
      },
      run: async () => {
        ran = true;
      },
    });
    await Bun.sleep(15);
    expect(heartbeats).toBeGreaterThan(0);
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(RunDisconnectedError);
    releaseHost?.();
    await Promise.resolve();
    expect(ran).toBe(false);
    expect(queue.snapshot()).toEqual({ activeRuns: 0, queueDepth: 0 });
  });

  test("enforces the host lease across separate semaphore instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-host-lease-"));
    const path = join(directory, "gateway.sqlite");
    const firstStore = new RunStore(path);
    const secondStore = new RunStore(path);
    const first = new HostSemaphore({
      limit: 1,
      leaseStore: firstStore,
      pollMs: 2,
    });
    const second = new HostSemaphore({
      limit: 1,
      leaseStore: secondStore,
      pollMs: 2,
    });
    const firstRelease = first.tryAcquire("codex:run-1");
    expect(firstRelease).toBeDefined();
    expect(second.tryAcquire("claude:run-1")).toBeUndefined();

    const waiting = second.acquire(
      new AbortController().signal,
      "claude:run-1",
    );
    firstRelease?.();
    const secondRelease = await waiting;
    expect(second.activeCount).toBe(1);
    secondRelease();
    firstStore.close();
    secondStore.close();
    await rm(directory, { recursive: true });
  });
});
