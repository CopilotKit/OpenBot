import { afterEach, describe, expect, test } from "bun:test";
import { identityProvidersQueryOptions } from "./queries";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(response: Response) {
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
}

const problem = (status: number, code: string, detail: string) =>
  Response.json(
    { type: "about:blank", title: detail, status, detail, code },
    { status, headers: { "content-type": "application/problem+json" } },
  );

const read = () =>
  identityProvidersQueryOptions().queryFn?.({
    signal: new AbortController().signal,
  } as never) as Promise<{ slack: boolean; github: boolean }>;

describe("which account types can be linked", () => {
  test("reads the services the API lists", async () => {
    answer(
      Response.json({
        linkedAccountProviders: [{ id: "github", title: "GitHub" }],
        nextCursor: null,
      }),
    );
    expect(await read()).toEqual({ slack: false, github: true });
  });

  test("the API's own 503 means nothing is linkable", async () => {
    answer(
      problem(
        503,
        "LINKED_ACCOUNTS_UNAVAILABLE",
        "Linked accounts are not available.",
      ),
    );
    expect(await read()).toEqual({ slack: false, github: false });
  });

  test("any other 503 throws the server's message", async () => {
    answer(Response.json({ error: "Bad gateway" }, { status: 503 }));
    await expect(read()).rejects.toThrow("Bad gateway");
  });
});
