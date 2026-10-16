import { describe, expect, test } from "bun:test";
import {
  createIntelligenceThreadLock,
  type ThreadLockClient,
} from "../src/copilotkit/thread-lock";

/**
 * The lock a hop takes on a conversation, as the platform issues it.
 *
 * The property that matters is the one line between "busy" and "broken": a 409 is somebody else's
 * run and the hop waits, and every other failure is raised so the person is eventually told the real
 * reason rather than that their conversation was busy.
 */

const INPUT = {
  threadId: "thread-1",
  runId: "run-asked",
  userId: "user-1",
  agentId: "researcher",
};

function platformError(status: number): Error {
  const error = new Error(`HTTP ${status}`);
  (error as Error & { status?: number }).status = status;
  return error;
}

function harness(
  options: {
    acquire?: () => unknown;
    container?: string;
    onRunBusy?: (input: { threadId: string; busy: boolean }) => void;
  } = {},
) {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const busy: { threadId: string; busy: boolean }[] = [];
  const client = {
    getOrCreateThread: async (input: Record<string, unknown>) => {
      calls.push({ method: "getOrCreateThread", input });
      return {};
    },
    ɵacquireThreadLock: async (input: Record<string, unknown>) => {
      calls.push({ method: "acquire", input });
      if (options.acquire) return options.acquire();
      return { runId: "platform-run", joinToken: "browser-only" };
    },
    ɵrenewThreadLock: async (input: Record<string, unknown>) => {
      calls.push({ method: "renew", input });
    },
    ɵcleanupThreadLock: async (input: Record<string, unknown>) => {
      calls.push({ method: "cleanup", input });
    },
  } as unknown as ThreadLockClient;
  const lock = createIntelligenceThreadLock({
    client,
    ...(options.container
      ? {
          learning: {
            containerForThread: async () => options.container,
          },
        }
      : {}),
    onRunBusy:
      options.onRunBusy ??
      ((input) => {
        busy.push(input);
      }),
  });
  return { lock, calls, busy };
}

describe("taking a conversation's lock", () => {
  test("creates the thread, then locks it, and hands back the platform's run id only", async () => {
    const { lock, calls } = harness();

    expect(await lock.acquire(INPUT)).toEqual({ runId: "platform-run" });
    expect(calls.map((call) => call.method)).toEqual([
      "getOrCreateThread",
      "acquire",
    ]);
  });

  test("a conversation somebody else is running in is busy, not broken", async () => {
    const { lock, busy } = harness({
      acquire: () => {
        throw platformError(409);
      },
    });

    expect(await lock.acquire(INPUT)).toBeNull();
    expect(busy).toEqual([]);
  });

  test("any other failure is raised, so it is not mistaken for contention", async () => {
    for (const status of [401, 404, 500, 503]) {
      const { lock } = harness({
        acquire: () => {
          throw platformError(status);
        },
      });
      await expect(lock.acquire(INPUT)).rejects.toThrow(`HTTP ${status}`);
    }
  });

  test("a failure with no status at all is raised too", async () => {
    const { lock } = harness({
      acquire: () => {
        throw new Error("socket hang up");
      },
    });

    await expect(lock.acquire(INPUT)).rejects.toThrow("socket hang up");
  });

  test("the thread and the lock both carry the Learning container when there is one", async () => {
    const { lock, calls } = harness({ container: "container-1" });

    await lock.acquire(INPUT);

    for (const call of calls) {
      expect(call.input.learningContainerId).toBe("container-1");
    }
  });

  test("lights the conversation as busy once the lock is held", async () => {
    const { lock, busy } = harness();

    await lock.acquire(INPUT);

    expect(busy).toEqual([{ threadId: "thread-1", busy: true }]);
  });

  test("a busy signal that throws does not cost the run its lock", async () => {
    const { lock } = harness({
      onRunBusy: () => {
        throw new Error("channel gone");
      },
    });

    expect(await lock.acquire(INPUT)).toEqual({ runId: "platform-run" });
  });
});

describe("keeping and giving back the lock", () => {
  test("renews for the platform's own lifetime", async () => {
    const { lock, calls } = harness();

    await lock.renew({ threadId: "thread-1", runId: "platform-run" });

    expect(calls).toEqual([
      {
        method: "renew",
        input: {
          threadId: "thread-1",
          runId: "platform-run",
          // The literal, not the constant, so moving the lifetime off the platform's 120 fails here.
          ttlSeconds: 120,
        },
      },
    ]);
  });

  test("release clears the busy signal and cleans up the exact run", async () => {
    const { lock, calls, busy } = harness();

    await lock.release({ threadId: "thread-1", runId: "platform-run" });

    expect(busy).toEqual([{ threadId: "thread-1", busy: false }]);
    expect(calls).toEqual([
      {
        method: "cleanup",
        input: { threadId: "thread-1", runId: "platform-run" },
      },
    ]);
  });

  test("a busy signal that throws does not stop the lock being given back", async () => {
    const { lock, calls } = harness({
      onRunBusy: () => {
        throw new Error("channel gone");
      },
    });

    await lock.release({ threadId: "thread-1", runId: "platform-run" });

    expect(calls.map((call) => call.method)).toEqual(["cleanup"]);
  });
});
