import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  PeopleCursorError,
  decodeCursor,
  type PeopleStore,
  type Person,
} from "../src/people/store";
import { testEnvironment } from "./support/environment";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

const ADMIN = {
  id: "admin-1",
  email: "admin@openbot.test",
  name: "An Administrator",
  image: null,
};

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: "u1",
    email: "member@openbot.test",
    name: "A Member",
    image: null,
    role: "user",
    providers: ["google"],
    lastSignedInAt: null,
    revoked: false,
    configuredAdmin: false,
    ...overrides,
  };
}

function appWith(
  people: Person[],
  opts: { calls?: string[]; list?: PeopleStore["list"] } = {},
): {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  calls: string[];
} {
  const calls: string[] = opts.calls ?? [];
  const store: PeopleStore = {
    list: async (query) => {
      calls.push(`list:${JSON.stringify(query ?? {})}`);
      if (opts.list) return opts.list(query);
      return { people, nextCursor: null };
    },
    find: async (userId) => people.find((entry) => entry.id === userId),
    setRole: async () => {},
    revoke: async () => {},
    retireOwned: async () => {},
    restore: async () => {},
    isRevoked: async () => false,
  };

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => ["admin"] },
    ...(Array.from({ length: 14 }) as never[]),
    store as never,
  );

  return {
    request: (path, init) => app.request(`http://openbot.test${path}`, init),
    calls,
  };
}

describe("decodeCursor", () => {
  test("round-trips a cursor the store wrote", () => {
    const cursor = encode({
      email: "a@x.test",
      lastSignedInAt: "2026-01-01T00:00:00.000Z",
    });
    expect(decodeCursor(cursor)).toEqual({
      email: "a@x.test",
      lastSignedInAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("reads a null lastSignedInAt as the end of the list", () => {
    const cursor = encode({ email: "a@x.test", lastSignedInAt: null });
    expect(decodeCursor(cursor)).toEqual({
      email: "a@x.test",
      lastSignedInAt: null,
    });
  });

  test.each([[undefined], [""]])("reads %p as no cursor", (value) => {
    expect(decodeCursor(value)).toBeUndefined();
  });

  test.each([
    ["not-a-cursor"],
    ["!!!"],
    [encode(null)],
    [encode([])],
    [encode("cursor")],
    [encode(42)],
    [encode({})],
    [encode({ email: 42, lastSignedInAt: null })],
    [encode({ email: "", lastSignedInAt: null })],
    [encode({ lastSignedInAt: "2026-01-01T00:00:00.000Z" })],
    // Checked as a string before it is checked as a date: `Date.parse` stringifies
    // whatever it is handed, so a `lastSignedInAt` of `2020` parses as the year 2020
    // while the query builder reads it as 2020 milliseconds after 1970. See audit.ts.
    [encode({ email: "a@x.test", lastSignedInAt: 2020 })],
    [encode({ email: "a@x.test", lastSignedInAt: "not-a-date" })],
    [encode({ email: "a@x.test", lastSignedInAt: "" })],
  ])("refuses %p as a caller error", (value) => {
    expect(() => decodeCursor(value as string)).toThrow(PeopleCursorError);
    expect(() => decodeCursor(value as string)).toThrow(
      "cursor must be a valid people page cursor",
    );
  });

  test("rebuilds the two fields so extra input never reaches the query", () => {
    const cursor = encode({
      email: "a@x.test",
      lastSignedInAt: null,
      injected: "select * from users",
    });
    expect(decodeCursor(cursor)).toEqual({
      email: "a@x.test",
      lastSignedInAt: null,
    });
  });
});

describe("people list cursor", () => {
  test.each([["not-a-cursor"], ["!!!"]])(
    "refuses a garbage cursor %p with 400 and never reaches the store",
    async (cursor) => {
      const { request, calls } = appWith([person()]);

      const response = await request(
        `/api/admin/people?cursor=${encodeURIComponent(cursor)}`,
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "cursor must be a valid people page cursor",
      });
      expect(calls).toEqual([]);
    },
  );

  test("refuses a well-formed cursor with a non-date lastSignedInAt with 400", async () => {
    const { request, calls } = appWith([person()]);
    const cursor = encode({ email: "a@x.test", lastSignedInAt: "not-a-date" });

    const response = await request(
      `/api/admin/people?cursor=${encodeURIComponent(cursor)}`,
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("maps a store-level cursor refusal to 400", async () => {
    const { request } = appWith([person()], {
      list: async () => {
        throw new PeopleCursorError();
      },
    });

    const response = await request("/api/admin/people?cursor=not-a-cursor");

    // The edge validation fires first here; either layer answering 400 is the contract.
    expect(response.status).toBe(400);
  });

  test("passes a well-formed cursor through to the store", async () => {
    const { request, calls } = appWith([person()]);
    const cursor = encode({
      email: "a@x.test",
      lastSignedInAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await request(
      `/api/admin/people?cursor=${encodeURIComponent(cursor)}`,
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([`list:${JSON.stringify({ cursor })}`]);
  });
});
