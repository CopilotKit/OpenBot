import { describe, expect, test } from "bun:test";
import { fetchTrajectorySummaries } from "../src/recorder/recordings";

const base = { apiUrl: "http://intelligence.test/", apiKey: "key-1" };

function answering(status: number, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("fetchTrajectorySummaries", () => {
  test("a 404 from Intelligence says unavailable", async () => {
    const { fetcher } = answering(404);
    expect(
      await fetchTrajectorySummaries({ ...base, fetch: fetcher, ids: ["a"] }),
    ).toEqual({ unavailable: "unavailable" });
  });

  test("a 403 says unavailable", async () => {
    const { fetcher } = answering(403);
    expect(
      await fetchTrajectorySummaries({ ...base, fetch: fetcher, ids: ["a"] }),
    ).toEqual({ unavailable: "unavailable" });
  });

  test("a network error says unreachable", async () => {
    const fetcher = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    expect(
      await fetchTrajectorySummaries({ ...base, fetch: fetcher, ids: ["a"] }),
    ).toEqual({ unavailable: "unreachable" });
  });

  test("a 500 says unreachable", async () => {
    const { fetcher } = answering(500);
    expect(
      await fetchTrajectorySummaries({ ...base, fetch: fetcher, ids: ["a"] }),
    ).toEqual({ unavailable: "unreachable" });
  });

  test("empty ids make no request", async () => {
    const { fetcher, calls } = answering(200);
    expect(
      await fetchTrajectorySummaries({ ...base, fetch: fetcher, ids: [] }),
    ).toEqual({ items: [] });
    expect(calls).toHaveLength(0);
  });

  test("the request carries the bearer key and the ids joined", async () => {
    const item = {
      trajectoryId: "a",
      createdAt: "2026-01-01T00:00:00Z",
      firstEventAt: null,
      lastEventAt: null,
      eventCount: 0,
      workflow: null,
      outcome: null,
    };
    const { fetcher, calls } = answering(200, { items: [item] });
    const result = await fetchTrajectorySummaries({
      ...base,
      fetch: fetcher,
      ids: ["a", "b/c"],
    });
    expect(result).toEqual({ items: [item] });
    expect(calls[0]?.url).toBe(
      "http://intelligence.test/api/v1/trajectories?ids=a,b%2Fc",
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer key-1");
    expect(headers.accept).toBe("application/json");
    expect(calls[0]?.init.redirect).toBe("error");
  });
});
