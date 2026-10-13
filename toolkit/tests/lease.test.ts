import { describe, expect, test } from "bun:test";
import { isLockConflict, keepLease } from "../src/lease";

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
      onLost: (error) => lost.push(error),
    });
    await wait(30);
    lease.stop();
    expect(renewals).toBeGreaterThan(2);
    expect(lost).toEqual([]);
  });
});
