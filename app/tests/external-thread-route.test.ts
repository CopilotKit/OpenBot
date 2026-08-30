import { describe, expect, test } from "bun:test";
import {
  externalThreadKeys,
  externalThreadListQueryOptions,
  externalThreadPage,
  externalThreadTarget,
} from "../src/lib/external/queries";

describe("external Slack transcript target", () => {
  test("accepts the authenticated read-only target returned by OpenBot", () => {
    expect(
      externalThreadTarget({
        threadId: "channels-thread-1",
        agentId: "risk",
        agentName: "Risk Analyst",
        provider: "slack",
        readOnly: true,
      }),
    ).toEqual({
      threadId: "channels-thread-1",
      agentId: "risk",
      agentName: "Risk Analyst",
      provider: "slack",
      readOnly: true,
    });
  });

  test("rejects writable or malformed targets", () => {
    for (const value of [
      null,
      {},
      { threadId: "t", agentId: "a", agentName: "A", provider: "slack" },
      {
        threadId: "t",
        agentId: "a",
        agentName: "A",
        provider: "slack",
        readOnly: false,
      },
    ]) {
      expect(() => externalThreadTarget(value)).toThrow(
        "Could not load this Slack conversation",
      );
    }
  });
});

describe("external Slack transcript list", () => {
  const validThread = {
    threadId: "channels-thread-1",
    agentId: "risk",
    agentName: "Risk Analyst",
    provider: "slack",
    readOnly: true,
    lastMessage: "Review the queue",
    lastMessageAt: "2026-08-25T12:00:00.000Z",
    createdAt: "2026-08-25T11:00:00.000Z",
  };

  test("accepts a server page of authenticated read-only Slack summaries", () => {
    expect(
      externalThreadPage({
        threads: [validThread, { ...validThread, lastMessage: null }],
        nextCursor: "opaque-next",
      }),
    ).toEqual({
      threads: [validThread, { ...validThread, lastMessage: null }],
      nextCursor: "opaque-next",
    });
  });

  test("rejects malformed conversation pages and summaries", () => {
    for (const value of [
      null,
      [],
      {},
      { threads: [] },
      { threads: "not-array", nextCursor: null },
      { threads: [], nextCursor: "" },
      { threads: [], nextCursor: 42 },
      { threads: [{ ...validThread, threadId: "" }], nextCursor: null },
      { threads: [{ ...validThread, agentId: "" }], nextCursor: null },
      { threads: [{ ...validThread, agentName: "" }], nextCursor: null },
      { threads: [{ ...validThread, provider: "teams" }], nextCursor: null },
      { threads: [{ ...validThread, readOnly: false }], nextCursor: null },
      { threads: [{ ...validThread, lastMessage: 123 }], nextCursor: null },
      {
        threads: [{ ...validThread, lastMessageAt: "not-a-date" }],
        nextCursor: null,
      },
      {
        threads: [{ ...validThread, lastMessageAt: "2026-08-25T12:00:00Z" }],
        nextCursor: null,
      },
      {
        threads: [{ ...validThread, createdAt: "not-a-date" }],
        nextCursor: null,
      },
    ]) {
      expect(() => externalThreadPage(value)).toThrow(
        "Could not load Slack conversations",
      );
    }
  });

  test("exposes stable external thread query keys", () => {
    expect(externalThreadKeys.all).toEqual(["external-threads"]);
    expect(externalThreadKeys.list()).toEqual(["external-threads", "list"]);
    expect(externalThreadKeys.detail("channels-thread-1")).toEqual([
      "external-threads",
      "detail",
      "channels-thread-1",
    ]);
  });

  test("builds a flattened cursor-based infinite query", () => {
    const options = externalThreadListQueryOptions();
    const page = externalThreadPage({
      threads: [validThread],
      nextCursor: "opaque-next",
    });
    const finalPage = externalThreadPage({
      threads: [{ ...validThread, threadId: "channels-thread-2" }],
      nextCursor: null,
    });

    expect(options.queryKey).toEqual(externalThreadKeys.list());
    expect(options.initialPageParam).toBe("");
    expect(options.getNextPageParam?.(page, [], "")).toBe("opaque-next");
    expect(options.getNextPageParam?.(finalPage, [], "")).toBeUndefined();
    expect(
      options.select?.({
        pages: [page, finalPage],
        pageParams: ["", "opaque-next"],
      }),
    ).toEqual([validThread, { ...validThread, threadId: "channels-thread-2" }]);
  });

  test("fetches cursor pages with an encoded opaque cursor and validates the response", async () => {
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      requests.push(String(input));
      expect(init?.credentials).toBe("include");
      return new Response(
        JSON.stringify({
          threads: [validThread],
          nextCursor: "next cursor",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      );
    };

    try {
      const options = externalThreadListQueryOptions();
      if (typeof options.queryFn !== "function") {
        throw new Error("Expected external thread list to have a queryFn");
      }

      const page = await options.queryFn({
        pageParam: "cursor value/?",
      } as Parameters<typeof options.queryFn>[0]);

      expect(requests).toEqual([
        "/api/external-links/threads?cursor=cursor%20value%2F%3F",
      ]);
      expect(page).toEqual({
        threads: [validThread],
        nextCursor: "next cursor",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
