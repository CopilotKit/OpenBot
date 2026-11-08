import { describe, expect, test } from "bun:test";
import type {
  RecordingEnded,
  RecordingRow,
} from "@openbot/shared/recorder-api";
import {
  createRecordings,
  fetchTrajectorySummaries,
  type TrajectorySummary,
  toRow,
} from "../src/recorder/recordings";

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

  test("a 401, a 400 or another 4xx says unavailable, since trying again will not help", async () => {
    for (const status of [400, 401, 422]) {
      const { fetcher } = answering(status);
      expect(
        await fetchTrajectorySummaries({ ...base, fetch: fetcher, ids: ["a"] }),
      ).toEqual({ unavailable: "unavailable" });
    }
  });

  test("a 408 or 429 may pass, so it says unreachable", async () => {
    for (const status of [408, 429]) {
      const { fetcher } = answering(status);
      expect(
        await fetchTrajectorySummaries({ ...base, fetch: fetcher, ids: ["a"] }),
      ).toEqual({ unavailable: "unreachable" });
    }
  });

  test("a malformed item is dropped and the rest are kept", async () => {
    const good = {
      trajectoryId: "t-1",
      createdAt: "2026-11-06T09:00:00.000Z",
      firstEventAt: null,
      lastEventAt: null,
      eventCount: 1,
      workflow: null,
      outcome: null,
    };
    const { fetcher } = answering(200, {
      items: [null, 7, { trajectoryId: 5 }, { ...good, eventCount: "x" }, good],
    });
    const result = await fetchTrajectorySummaries({
      ...base,
      fetch: fetcher,
      ids: ["t-1"],
    });
    expect(result).toEqual({ items: [good] });
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

describe("toRow", () => {
  const now = new Date("2026-11-06T12:00:00.000Z");
  const binding = {
    trajectoryId: "t-1",
    createdAt: new Date("2026-11-06T09:00:00.000Z"),
  };
  const minutesAgo = (minutes: number) =>
    new Date(now.getTime() - minutes * 60_000).toISOString();
  const summary = (
    outcome: TrajectorySummary["outcome"],
    lastEventAt: string | null = null,
  ): TrajectorySummary => ({
    trajectoryId: "t-1",
    createdAt: "2026-11-06T09:00:00.000Z",
    firstEventAt: "2026-11-06T09:01:00.000Z",
    lastEventAt,
    eventCount: 3,
    workflow: "Refund an order",
    outcome,
  });
  const row = (
    ended: RecordingEnded,
    reason: string | null = null,
  ): RecordingRow => ({
    id: "t-1",
    title: "Refund an order",
    recordedAt: "2026-11-06T09:01:00.000Z",
    ended,
    reason,
  });

  test("succeeded", () => {
    expect(
      toRow(binding, summary({ phase: "succeeded", reason: null }), now),
    ).toEqual(row("succeeded"));
  });

  test("a discarded recording is hidden", () => {
    expect(
      toRow(binding, summary({ phase: "failed", reason: "discarded" }), now),
    ).toBeNull();
  });

  test("a restarted recording is hidden", () => {
    expect(
      toRow(binding, summary({ phase: "failed", reason: "restarted" }), now),
    ).toBeNull();
  });

  test("disconnected is stopped, with its reason", () => {
    expect(
      toRow(binding, summary({ phase: "failed", reason: "disconnected" }), now),
    ).toEqual(row("stopped", "disconnected"));
  });

  test("started 5 minutes ago is sending", () => {
    expect(
      toRow(
        binding,
        summary({ phase: "started", reason: null }, minutesAgo(5)),
        now,
      ),
    ).toEqual(row("sending"));
  });

  test("started 30 minutes ago is unknown", () => {
    expect(
      toRow(
        binding,
        summary({ phase: "started", reason: null }, minutesAgo(30)),
        now,
      ),
    ).toEqual(row("unknown"));
  });

  test("bound seconds ago with no summary yet is sending", () => {
    expect(
      toRow(
        { trajectoryId: "t-1", createdAt: new Date(now.getTime() - 30_000) },
        undefined,
        now,
      )?.ended,
    ).toBe("sending");
  });

  test("absent from Intelligence is missing, dated by the binding", () => {
    expect(toRow(binding, undefined, now)).toEqual({
      id: "t-1",
      title: null,
      recordedAt: "2026-11-06T09:00:00.000Z",
      ended: "missing",
      reason: null,
    });
  });
});

describe("createRecordings", () => {
  const now = new Date("2026-11-06T12:00:00.000Z");
  const bound = {
    trajectoryId: "t-1",
    createdAt: new Date("2026-11-06T09:00:00.000Z"),
  };
  const summary: TrajectorySummary = {
    trajectoryId: "t-1",
    createdAt: "2026-11-06T09:00:00.000Z",
    firstEventAt: "2026-11-06T09:01:00.000Z",
    lastEventAt: null,
    eventCount: 3,
    workflow: "Refund an order",
    outcome: { phase: "succeeded", reason: null },
  };
  type Summaries = Parameters<typeof createRecordings>[0]["summaries"];
  function build(
    ids: (typeof bound)[],
    result: Awaited<ReturnType<Summaries>>,
  ) {
    const asked: string[][] = [];
    const recordings = createRecordings({
      pageForUser: async () => ({ ids, nextCursor: "next" }),
      isBoundTo: async () => true,
      summaries: async (requested) => {
        asked.push(requested);
        return result;
      },
      now: () => now,
    });
    return { recordings, asked };
  }

  test("no recordings means no call to Intelligence", async () => {
    const { recordings, asked } = build([], { items: [] });
    expect(await recordings.list("u-1", null)).toEqual({
      recordings: [],
      nextCursor: "next",
    });
    expect(asked).toHaveLength(0);
  });

  test("a 404 from Intelligence says unavailable and still lists nothing", async () => {
    const { recordings } = build([bound], { unavailable: "unavailable" });
    expect(await recordings.list("u-1", null)).toEqual({
      recordings: [],
      nextCursor: null,
      unavailable: "unavailable",
    });
  });

  test("a later page that cannot be read keeps its cursor so it can be retried", async () => {
    const { recordings } = build([bound], { unavailable: "unreachable" });
    expect(await recordings.list("u-1", "c2")).toEqual({
      recordings: [],
      nextCursor: "c2",
      unavailable: "unreachable",
    });
  });

  test("a recording is joined to its summary by id", async () => {
    const { recordings, asked } = build([bound], { items: [summary] });
    const page = await recordings.list("u-1", null);
    expect(asked).toEqual([["t-1"]]);
    expect(page.nextCursor).toBe("next");
    expect(page.recordings).toEqual([
      {
        id: "t-1",
        title: "Refund an order",
        recordedAt: "2026-11-06T09:01:00.000Z",
        ended: "succeeded",
        reason: null,
      },
    ]);
  });

  test("recordings are listed by when they were made, not by when OpenBot first heard of them", async () => {
    // OpenBot Desktop, 2026-11-07: three recordings held by the Recorder reached OpenBot together minutes later, and
    // Teach a Bot listed them 8:46, 8:49, 8:41, in the order of those late bindings.
    const at = (minute: number) =>
      `2026-11-07T04:${String(minute).padStart(2, "0")}:00.000Z`;
    const late = new Date("2026-11-07T04:57:46.062Z");
    const made = [
      { trajectoryId: "t-46", minute: 46 },
      { trajectoryId: "t-49", minute: 49 },
      { trajectoryId: "t-41", minute: 41 },
    ];
    const { recordings } = build(
      made.map(({ trajectoryId }) => ({ trajectoryId, createdAt: late })),
      {
        items: made.map(({ trajectoryId, minute }) => ({
          ...summary,
          trajectoryId,
          createdAt: at(minute),
          firstEventAt: at(minute),
        })),
      },
    );
    const page = await recordings.list("u-1", null);
    expect(page.recordings.map((row) => row.recordedAt)).toEqual([
      at(49),
      at(46),
      at(41),
    ]);
  });

  test("a discarded recording is left out", async () => {
    const { recordings } = build([bound], {
      items: [
        { ...summary, outcome: { phase: "failed", reason: "discarded" } },
      ],
    });
    expect((await recordings.list("u-1", null)).recordings).toEqual([]);
  });

  describe("recordingTitles", () => {
    const own = "11111111-1111-4111-8111-111111111111";
    const other = "22222222-2222-4222-8222-222222222222";
    function titles(result: Awaited<ReturnType<Summaries>>) {
      const asked: string[][] = [];
      const recordings = createRecordings({
        pageForUser: async () => ({ ids: [], nextCursor: null }),
        isBoundTo: async (id) => id === own,
        boundTo: async (_userId, ids) =>
          new Set(ids.filter((id) => id === own)),
        summaries: async (requested) => {
          asked.push(requested);
          return result;
        },
        now: () => now,
      });
      return { recordings, asked };
    }

    test("recordingTitles never sends another person's ids", async () => {
      const { recordings, asked } = titles({
        items: [{ ...summary, trajectoryId: own }],
      });
      const found = await recordings.recordingTitles("u-1", [
        own,
        other,
        own,
        "not-a-uuid",
      ]);
      expect(asked).toEqual([[own]]);
      expect(found).toEqual(new Map([[own, "Refund an order"]]));
    });

    test("ownership is one query, and Intelligence is asked 100 ids at a time", async () => {
      const many = Array.from(
        { length: 250 },
        (_, index) =>
          `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
      );
      const asked: string[][] = [];
      let boundCalls = 0;
      const recordings = createRecordings({
        pageForUser: async () => ({ ids: [], nextCursor: null }),
        isBoundTo: async () => {
          throw new Error("one id at a time");
        },
        boundTo: async (_userId, ids) => {
          boundCalls += 1;
          return new Set(ids);
        },
        summaries: async (requested) => {
          asked.push(requested);
          return { items: [] };
        },
        now: () => now,
      });
      const found = await recordings.recordingTitles("u-1", many);
      expect(boundCalls).toBe(1);
      expect(asked.map((batch) => batch.length)).toEqual([100, 100, 50]);
      expect(found.size).toBe(250);
    });

    test("none owned means an empty map and no call", async () => {
      const { recordings, asked } = titles({ items: [] });
      expect(await recordings.recordingTitles("u-1", [other])).toEqual(
        new Map(),
      );
      expect(asked).toHaveLength(0);
    });

    test("an owned id Intelligence does not return, or cannot be read, has no title", async () => {
      const missing = titles({ items: [] });
      expect(await missing.recordings.recordingTitles("u-1", [own])).toEqual(
        new Map([[own, null]]),
      );
      const down = titles({ unavailable: "unreachable" });
      expect(await down.recordings.recordingTitles("u-1", [own])).toEqual(
        new Map([[own, null]]),
      );
    });
  });
});
