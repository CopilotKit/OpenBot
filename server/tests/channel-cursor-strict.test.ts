import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  ChannelCursorError,
  createChannelRoutes,
  decodeChannelCursor,
  encodeChannelCursor,
  type ChannelStore,
} from "../src/channels/routes";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

const actor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
} as const;

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

function appFor(store: ChannelStore) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createChannelRoutes(store, requireUser));
  return app;
}

function fakeStore(calls: { queries: unknown[] }): ChannelStore {
  return {
    create: async () => {
      throw new Error("not reached");
    },
    get: async () => null,
    list: async (_actor, query) => {
      calls.queries.push(query);
      return { channels: [], nextCursor: null };
    },
    setPinned: async () => {},
    markRead: async () => {},
    softDelete: async () => {},
    recordActivity: async () => {},
    signalBusy: async () => {},
    signalChannelBusy: async () => {},
  };
}

describe("decodeChannelCursor", () => {
  test("round-trips a cursor the encoder wrote", () => {
    const cursor = encodeChannelCursor({
      pinned: true,
      recency: "2026-09-01T00:00:00.000Z",
      id: "channel-1",
    });
    expect(decodeChannelCursor(cursor)).toEqual({
      pinned: true,
      recency: "2026-09-01T00:00:00.000Z",
      id: "channel-1",
    });
  });

  test.each([[undefined], [""]])("reads %p as no cursor", (value) => {
    expect(decodeChannelCursor(value)).toBeUndefined();
  });

  test.each([
    ["not-a-cursor"],
    ["!!!"],
    [encode(null)],
    [encode([])],
    [encode("cursor")],
    [encode(42)],
    // A cursor minted before `pinned` existed describes a position in an ordering this
    // query no longer has.
    [encode({ recency: "2026-09-01T00:00:00.000Z", id: "channel-1" })],
    [encode({ pinned: "yes", recency: "2026-09-01T00:00:00.000Z", id: "c1" })],
    [encode({ pinned: true, recency: "2026-09-01T00:00:00.000Z", id: 42 })],
    [encode({ pinned: true, recency: "2026-09-01T00:00:00.000Z", id: "" })],
    [encode({ pinned: true, recency: 2020, id: "c1" })],
    // Checked as a date before it is checked as SQL: `2020` parses as the year 2020 while
    // `new Date(2020)` is 2020 milliseconds after 1970. See audit.ts for the same trap.
    [encode({ pinned: true, recency: "not-a-date", id: "c1" })],
    [encode({ pinned: false, recency: "", id: "c1" })],
  ])("refuses %p as a caller error", (value) => {
    expect(() => decodeChannelCursor(value as string)).toThrow(
      ChannelCursorError,
    );
    expect(() => decodeChannelCursor(value as string)).toThrow(
      "cursor must be a valid channel page cursor",
    );
  });

  test("rebuilds the three fields so extra input never reaches the query", () => {
    const cursor = encode({
      pinned: false,
      recency: "2026-09-01T00:00:00.000Z",
      id: "c1",
      injected: "select * from channels",
    });
    expect(decodeChannelCursor(cursor)).toEqual({
      pinned: false,
      recency: "2026-09-01T00:00:00.000Z",
      id: "c1",
    });
  });
});

describe("channel list cursor", () => {
  test.each([["not-a-cursor"], ["!!!"]])(
    "refuses a garbage cursor %p with 400 and never reaches the store",
    async (cursor) => {
      const calls = { queries: [] as unknown[] };
      const response = await appFor(fakeStore(calls)).request(
        `http://openbot.test/?cursor=${cursor}`,
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "cursor must be a valid channel page cursor",
      });
      expect(calls.queries).toEqual([]);
    },
  );

  test("refuses a well-formed cursor with a non-date recency with 400", async () => {
    const calls = { queries: [] as unknown[] };
    const cursor = encode({
      pinned: true,
      recency: "not-a-date",
      id: "channel-1",
    });
    const response = await appFor(fakeStore(calls)).request(
      `http://openbot.test/?cursor=${encodeURIComponent(cursor)}`,
    );

    expect(response.status).toBe(400);
    expect(calls.queries).toEqual([]);
  });

  test("refuses a legacy cursor without the pin flag with 400", async () => {
    const calls = { queries: [] as unknown[] };
    const cursor = encode({ recency: "2026-09-01T00:00:00.000Z", id: "c1" });
    const response = await appFor(fakeStore(calls)).request(
      `http://openbot.test/?cursor=${encodeURIComponent(cursor)}`,
    );

    expect(response.status).toBe(400);
    expect(calls.queries).toEqual([]);
  });

  test("passes a well-formed cursor through to the store", async () => {
    const calls = { queries: [] as unknown[] };
    const cursor = encodeChannelCursor({
      pinned: false,
      recency: "2026-09-01T00:00:00.000Z",
      id: "channel-1",
    });
    const response = await appFor(fakeStore(calls)).request(
      `http://openbot.test/?cursor=${encodeURIComponent(cursor)}`,
    );

    expect(response.status).toBe(200);
    expect(calls.queries).toEqual([{ cursor }]);
  });

  test("leaves an absent cursor to the store default", async () => {
    const calls = { queries: [] as unknown[] };
    const response = await appFor(fakeStore(calls)).request(
      "http://openbot.test/",
    );

    expect(response.status).toBe(200);
    expect(calls.queries).toEqual([{}]);
  });
});
