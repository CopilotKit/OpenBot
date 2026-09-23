import { describe, expect, test } from "bun:test";
import {
  computeBackoffMs,
  dispatchWithRetry,
  isRetryableStatus,
  type FetchLike,
} from "../src/retry";

const url = "http://server:3001/internal/routines/run";
const headers = {
  authorization: "Bearer secret",
  "content-type": "application/json",
};
const body = JSON.stringify({ routineRunId: "run-1" });

describe("isRetryableStatus", () => {
  test.each([408, 429, 502, 503, 504])("retries %p", (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  test.each([200, 202, 400, 401, 403, 404, 409, 422, 500])(
    "does not retry %p as a status decision",
    (status) => {
      // 500 is deliberately not retried on status alone: it is as likely to be a
      // persistent dispatch bug as a blip, and the sweep already re-offers. Transport
      // failures (the fetch throwing) are still retried.
      if (status === 500) {
        expect(isRetryableStatus(status)).toBe(false);
      } else {
        expect(isRetryableStatus(status)).toBe(false);
      }
    },
  );
});

describe("computeBackoffMs", () => {
  test("backs off exponentially with bounded jitter", () => {
    expect(computeBackoffMs(1, 500, () => 0)).toBe(500);
    expect(computeBackoffMs(2, 500, () => 0)).toBe(1000);
    expect(computeBackoffMs(3, 500, () => 0)).toBe(2000);
    expect(computeBackoffMs(1, 500, () => 0.999)).toBeLessThanOrEqual(999);
    expect(computeBackoffMs(1, 500, () => 0.999)).toBeGreaterThanOrEqual(500);
  });
});

describe("dispatchWithRetry", () => {
  test("succeeds on the first 202 without sleeping", async () => {
    let calls = 0;
    const slept: number[] = [];
    await dispatchWithRetry(
      async () => {
        calls += 1;
        return { status: 202 };
      },
      url,
      headers,
      body,
      {
        retries: 3,
        timeoutMs: 1000,
        baseMs: 500,
        sleep: async (ms) => {
          slept.push(ms);
        },
        random: () => 0,
      },
    );
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  test("retries a transient 503 then succeeds", async () => {
    let calls = 0;
    const slept: number[] = [];
    await dispatchWithRetry(
      async () => {
        calls += 1;
        return { status: calls === 1 ? 503 : 202 };
      },
      url,
      headers,
      body,
      {
        retries: 3,
        timeoutMs: 1000,
        baseMs: 500,
        sleep: async (ms) => {
          slept.push(ms);
        },
        random: () => 0,
      },
    );
    expect(calls).toBe(2);
    expect(slept).toEqual([500]);
  });

  test("retries a network failure then succeeds", async () => {
    let calls = 0;
    await dispatchWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("fetch failed");
        return { status: 202 };
      },
      url,
      headers,
      body,
      {
        retries: 3,
        timeoutMs: 1000,
        baseMs: 500,
        sleep: async () => {},
        random: () => 0,
      },
    );
    expect(calls).toBe(2);
  });

  test("does not retry a 401", async () => {
    let calls = 0;
    const error = await dispatchWithRetry(
      async () => {
        calls += 1;
        return { status: 401 };
      },
      url,
      headers,
      body,
      {
        retries: 3,
        timeoutMs: 1000,
        baseMs: 500,
        sleep: async () => {},
        random: () => 0,
      },
    ).catch((error: Error) => error);
    expect(calls).toBe(1);
    expect(error.message).toContain("401");
  });

  test("gives up after exhausting retries, throwing the last status", async () => {
    let calls = 0;
    const slept: number[] = [];
    const error = await dispatchWithRetry(
      async () => {
        calls += 1;
        return { status: 503 };
      },
      url,
      headers,
      body,
      {
        retries: 2,
        timeoutMs: 1000,
        baseMs: 100,
        sleep: async (ms) => {
          slept.push(ms);
        },
        random: () => 0,
      },
    ).catch((error: Error) => error);
    expect(calls).toBe(3);
    expect(slept).toEqual([100, 200]);
    expect(error.message).toContain("503");
  });

  test("zero retries tries once", async () => {
    let calls = 0;
    const error = await dispatchWithRetry(
      async () => {
        calls += 1;
        return { status: 503 };
      },
      url,
      headers,
      body,
      {
        retries: 0,
        timeoutMs: 1000,
        baseMs: 500,
        sleep: async () => {},
        random: () => 0,
      },
    ).catch((error: Error) => error);
    expect(calls).toBe(1);
    expect(error.message).toContain("503");
  });

  test("sends the run id as JSON with the bearer credential", async () => {
    let seen: {
      url: string;
      init: { headers: Record<string, string>; body: string };
    } | null = null;
    await dispatchWithRetry(
      (async (
        requestUrl: string,
        init: {
          method: string;
          headers: Record<string, string>;
          body: string;
          signal: AbortSignal;
        },
      ) => {
        seen = { url: requestUrl, init };
        return { status: 202 };
      }) as FetchLike,
      url,
      headers,
      body,
      {
        retries: 1,
        timeoutMs: 1000,
        baseMs: 500,
        sleep: async () => {},
        random: () => 0,
      },
    );
    expect(seen?.url).toBe(url);
    expect(seen?.init.headers.authorization).toBe("Bearer secret");
    expect(JSON.parse(seen?.init.body ?? "{}")).toEqual({
      routineRunId: "run-1",
    });
  });
});
