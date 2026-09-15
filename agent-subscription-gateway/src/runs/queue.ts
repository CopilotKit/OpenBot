import type { RunCountSnapshot, RunCounts } from "../observability/run-counts";

export class CapacityError extends Error {
  readonly retryable = true;

  constructor() {
    super("The provider queue is full. Retry later.");
    this.name = "CapacityError";
  }
}

export class RunDisconnectedError extends Error {
  constructor() {
    super("The queued run lost its AG-UI connection.");
    this.name = "RunDisconnectedError";
  }
}

type Release = () => void;

export interface HostLeaseStore {
  tryAcquireHostLease(owner: string, limit: number): boolean;
  releaseHostLease(owner: string): void;
}

interface HostWaiter {
  grant: (release: Release) => void;
  signal: AbortSignal;
  owner: string;
  abort: () => void;
  poll?: ReturnType<typeof setInterval>;
}

export class HostSemaphore {
  private active = 0;
  private readonly waiters: HostWaiter[] = [];
  private readonly leaseStore?: HostLeaseStore;
  private readonly pollMs: number;
  private manualOwner = 0;

  readonly limit: number;

  constructor(
    options:
      | number
      | { limit?: number; leaseStore: HostLeaseStore; pollMs?: number } = 1,
  ) {
    this.limit = typeof options === "number" ? options : (options.limit ?? 1);
    this.leaseStore =
      typeof options === "number" ? undefined : options.leaseStore;
    this.pollMs = typeof options === "number" ? 50 : (options.pollMs ?? 50);
    if (!Number.isInteger(this.limit) || this.limit < 1) {
      throw new Error("Host concurrency must be a positive integer.");
    }
  }

  get activeCount(): number {
    return this.active;
  }

  tryAcquire(owner = `manual:${this.manualOwner++}`): Release | undefined {
    if (this.active >= this.limit || this.waiters.length > 0) return undefined;
    if (
      this.leaseStore &&
      !this.leaseStore.tryAcquireHostLease(owner, this.limit)
    ) {
      return undefined;
    }
    this.active += 1;
    return this.releaseOnce(owner);
  }

  acquire(signal: AbortSignal, owner: string): Promise<Release> {
    if (signal.aborted) return Promise.reject(new RunDisconnectedError());
    const immediate = this.tryAcquire(owner);
    if (immediate) return Promise.resolve(immediate);

    return new Promise<Release>((resolve, reject) => {
      const waiter: HostWaiter = {
        grant: resolve,
        signal,
        owner,
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          if (waiter.poll) clearInterval(waiter.poll);
          reject(new RunDisconnectedError());
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter);
      if (this.leaseStore) {
        waiter.poll = setInterval(() => this.grantNext(), this.pollMs);
      }
    });
  }

  private releaseOnce(owner: string): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.leaseStore?.releaseHostLease(owner);
      this.grantNext();
    };
  }

  private grantNext(): void {
    while (this.active < this.limit) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.poll) clearInterval(waiter.poll);
      if (waiter.signal.aborted) continue;
      if (
        this.leaseStore &&
        !this.leaseStore.tryAcquireHostLease(waiter.owner, this.limit)
      ) {
        this.waiters.unshift(waiter);
        waiter.poll = setInterval(() => this.grantNext(), this.pollMs);
        return;
      }
      this.active += 1;
      waiter.grant(this.releaseOnce(waiter.owner));
    }
  }
}

export interface QueuedRun<T> {
  runId: string;
  signal: AbortSignal;
  run: () => Promise<T> | T;
  onHeartbeat?: () => void;
}

interface QueueItem<T> extends QueuedRun<T> {
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  heartbeat?: ReturnType<typeof setInterval>;
}

export class BoundedRunQueue implements RunCounts {
  private readonly provider: string;
  private readonly host: HostSemaphore;
  private readonly concurrency: number;
  private readonly pendingLimit: number;
  private readonly heartbeatMs: number;
  private readonly pending: QueueItem<unknown>[] = [];
  private active = 0;
  private dispatching = 0;

  constructor(options: {
    provider: string;
    host: HostSemaphore;
    concurrency?: number;
    pendingLimit?: number;
    heartbeatMs?: number;
  }) {
    this.provider = options.provider;
    this.host = options.host;
    this.concurrency = options.concurrency ?? 1;
    this.pendingLimit = options.pendingLimit ?? 1;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    if (!this.provider.trim()) throw new Error("Provider is required.");
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) {
      throw new Error("Provider concurrency must be a positive integer.");
    }
    if (!Number.isInteger(this.pendingLimit) || this.pendingLimit < 0) {
      throw new Error("Pending limit must be a non-negative integer.");
    }
    if (!Number.isInteger(this.heartbeatMs) || this.heartbeatMs < 1) {
      throw new Error("Heartbeat interval must be a positive integer.");
    }
  }

  enqueue<T>(run: QueuedRun<T>): Promise<T> {
    const owner = `${this.provider}:${run.runId}`;
    const canStart =
      this.active + this.dispatching < this.concurrency &&
      this.pending.length === 0;
    const immediate = canStart ? this.host.tryAcquire(owner) : undefined;
    if (!immediate && this.pending.length >= this.pendingLimit)
      throw new CapacityError();
    if (run.signal.aborted) return Promise.reject(new RunDisconnectedError());

    const result = new Promise<T>((resolve, reject) => {
      const item = { ...run, resolve, reject } as QueueItem<T>;
      if (run.onHeartbeat) {
        item.heartbeat = setInterval(run.onHeartbeat, this.heartbeatMs);
      }
      this.pending.push(item as QueueItem<unknown>);
      if (immediate) this.start(item as QueueItem<unknown>, immediate);
      else this.drain();
    });
    return result;
  }

  snapshot(): RunCountSnapshot {
    return { queueDepth: this.pending.length, activeRuns: this.active };
  }

  started(): void {}

  finished(): void {}

  private drain(): void {
    while (
      this.active + this.dispatching < this.concurrency &&
      this.pending.length > this.dispatching
    ) {
      const item = this.pending[this.dispatching];
      const immediate = this.host.tryAcquire(`${this.provider}:${item.runId}`);
      if (immediate) {
        this.start(item, immediate);
        continue;
      }
      this.dispatching += 1;
      void this.waitForHost(item);
    }
  }

  private async waitForHost(item: QueueItem<unknown>): Promise<void> {
    let release: Release | undefined;
    try {
      release = await this.host.acquire(
        item.signal,
        `${this.provider}:${item.runId}`,
      );
      const index = this.pending.indexOf(item);
      if (index < 0 || item.signal.aborted) {
        throw new RunDisconnectedError();
      }
      this.dispatching = Math.max(0, this.dispatching - 1);
      this.start(item, release);
      release = undefined;
    } catch (error) {
      const index = this.pending.indexOf(item);
      if (index >= 0) this.pending.splice(index, 1);
      this.dispatching = Math.max(0, this.dispatching - 1);
      if (item.heartbeat) clearInterval(item.heartbeat);
      release?.();
      item.reject(error);
      this.drain();
    }
  }

  private start(item: QueueItem<unknown>, release: Release): void {
    const index = this.pending.indexOf(item);
    if (index < 0) {
      release();
      return;
    }
    this.pending.splice(index, 1);
    if (item.heartbeat) clearInterval(item.heartbeat);
    this.active += 1;
    void (async () => {
      try {
        const value = await item.run();
        this.active = Math.max(0, this.active - 1);
        release();
        this.drain();
        item.resolve(value);
      } catch (error) {
        this.active = Math.max(0, this.active - 1);
        release();
        this.drain();
        item.reject(error);
      }
    })();
  }
}
