import { describe, expect, test } from "bun:test";
import { isLockConflict, keepLease, LockLapsedError } from "../src/lease";

function platformError(status: number): Error {
  const error = new Error(`Intelligence platform error ${status}`);
  error.name = "PlatformRequestError";
  (error as Error & { status?: number }).status = status;
  return error;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("isLockConflict", () => {
  test("only the platform's 409 is a lock that belongs to somebody else", () => {
    expect(isLockConflict(platformError(409))).toBe(true);
    for (const status of [401, 404, 500, 503])
      expect(isLockConflict(platformError(status))).toBe(false);
    expect(isLockConflict(new TypeError("fetch failed"))).toBe(false);
    // The status alone is not enough: an unrelated error carrying 409 is not the platform's answer.
    expect(isLockConflict(Object.assign(new Error("x"), { status: 409 }))).toBe(
      false,
    );
    expect(isLockConflict(undefined)).toBe(false);
  });
});

describe("keepLease", () => {
  test("renews until stopped", async () => {
    let renewals = 0;
    const lease = keepLease({
      renew: async () => {
        renewals += 1;
      },
      everyMs: 2,
      lifetimeMs: 60_000,
      onLost: () => {
        throw new Error("not lost");
      },
    });
    await wait(20);
    lease.stop();
    const after = renewals;
    await wait(20);
    expect(after).toBeGreaterThan(1);
    expect(renewals).toBe(after);
  });

  test("a conflict stops the heartbeat and is reported once", async () => {
    const lost: unknown[] = [];
    let renewals = 0;
    keepLease({
      renew: async () => {
        renewals += 1;
        throw platformError(409);
      },
      everyMs: 2,
      lifetimeMs: 60_000,
      onLost: (error) => lost.push(error),
    });
    await wait(30);
    expect(lost).toHaveLength(1);
    expect(renewals).toBe(1);
  });

  test("a renewal that merely failed is skipped, and the next one still runs", async () => {
    const lost: unknown[] = [];
    let renewals = 0;
    const lease = keepLease({
      renew: async () => {
        renewals += 1;
        throw renewals % 2 ? new TypeError("fetch failed") : platformError(503);
      },
      everyMs: 2,
      lifetimeMs: 60_000,
      onLost: (error) => lost.push(error),
    });
    await wait(30);
    lease.stop();
    expect(renewals).toBeGreaterThan(2);
    expect(lost).toEqual([]);
  });

  /*
   * The time limit, on a clock each renewal moves forward by 10ms, so how many renewals fit in the
   * lifetime is exact rather than a matter of how fast the machine is.
   */
  test("failures that outlast the lifetime lose the lock, once, whatever they were", async () => {
    let clock = 0;
    let renewals = 0;
    const lost: unknown[] = [];
    keepLease({
      renew: async () => {
        renewals += 1;
        clock += 10;
        throw platformError(503);
      },
      everyMs: 1,
      lifetimeMs: 35,
      now: () => clock,
      onLost: (error) => lost.push(error),
    });
    await wait(40);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toBeInstanceOf(LockLapsedError);
    // Asked at 0, 10, 20 and 30; at 40 the lock has gone 40ms unrenewed, past 35 - 1.
    expect(renewals).toBe(4);
  });

  test("it gives up one interval before the lifetime, while the lock is still held", async () => {
    // The clock moves one interval per tick here, as it does for real.
    let clock = 0;
    let renewals = 0;
    const lostAt: number[] = [];
    keepLease({
      renew: async () => {
        renewals += 1;
        clock += 10;
        throw platformError(503);
      },
      everyMs: 10,
      lifetimeMs: 35,
      now: () => clock,
      onLost: () => lostAt.push(clock),
    });
    await wait(80);
    // Asked at 0, 10 and 20. At 30 the next tick would land at 40, past the 35ms lifetime, so it
    // stops now, at 30, with the lock still its own.
    expect(renewals).toBe(3);
    expect(lostAt).toEqual([30]);
  });

  test("a renewal that never settles still loses the lock when the lifetime passes", async () => {
    let clock = 0;
    const lost: unknown[] = [];
    keepLease({
      renew: () => {
        clock += 10;
        return new Promise(() => {});
      },
      everyMs: 1,
      lifetimeMs: 35,
      now: () => clock,
      onLost: (error) => lost.push(error),
    });
    await wait(40);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toBeInstanceOf(LockLapsedError);
  });

  test("a success inside the lifetime starts it again, so occasional blips never lose the lock", async () => {
    let clock = 0;
    let renewals = 0;
    const lost: unknown[] = [];
    const lease = keepLease({
      renew: async () => {
        renewals += 1;
        clock += 10;
        // Two failures, then a success, over and over: never 35ms without a renewal landing.
        if (renewals % 3) throw new TypeError("fetch failed");
      },
      everyMs: 1,
      lifetimeMs: 35,
      now: () => clock,
      onLost: (error) => lost.push(error),
    });
    await wait(40);
    lease.stop();
    expect(renewals).toBeGreaterThan(6);
    expect(lost).toEqual([]);
  });
});
