import { describe, expect, test } from "bun:test";
import { stoppedReason } from "../src/lib/copilot/stopped-turn";
import {
  isThreadLocked,
  THREAD_LOCKED,
  THREAD_LOCK_TRIES,
  threadLockWaitMs,
} from "../src/lib/copilot/thread-lock";

describe("a thread Intelligence still holds", () => {
  test("recognizes CopilotKit's AgentThreadLockedError and its sentence", () => {
    const locked = new Error(
      "Thread 09c796b7-25f0-8c9d-b03a-221e8f37d729 is locked",
    );
    locked.name = "AgentThreadLockedError";
    expect(isThreadLocked(locked)).toBe(true);
    expect(isThreadLocked("Thread is locked")).toBe(true);
    expect(
      isThreadLocked(
        'REST run request failed: {"error":{"code":"THREAD_LOCK_FAILED","message":"Thread is already locked by another runner."}}',
      ),
    ).toBe(true);
    expect(isThreadLocked("invalid x-api-key")).toBe(false);
  });

  test("tells the person the last reply is still finishing, not the thread id", () => {
    expect(
      stoppedReason(
        new Error("Thread 09c796b7-25f0-8c9d-b03a-221e8f37d729 is locked"),
      ),
    ).toBe(THREAD_LOCKED);
    expect(THREAD_LOCKED).not.toContain("09c796b7");
    expect(THREAD_LOCKED).toContain("try again");
  });

  test("a REST lock failure is not rewritten as an unreachable backend", () => {
    expect(
      stoppedReason(
        'REST run request failed: {"error":{"code":"THREAD_LOCK_FAILED","message":"Thread is already locked by another runner.","retryable":true}}',
      ),
    ).toBe(THREAD_LOCKED);
  });

  test("retries wait a little longer each time, and stop after a few tries", () => {
    expect(THREAD_LOCK_TRIES).toBeGreaterThanOrEqual(3);
    expect(threadLockWaitMs(0)).toBe(800);
    expect(threadLockWaitMs(1)).toBe(1600);
    expect(threadLockWaitMs(3)).toBe(3200);
    expect(threadLockWaitMs(10)).toBe(3200);
  });
});
