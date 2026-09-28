import { afterEach, describe, expect, test } from "bun:test";
import {
  BROWSER_ID_HEADER,
  BROWSER_ID_QUERY,
} from "../../shared/browser-identity";
import {
  BROWSER_ID_STORAGE_KEY,
  getBrowserId,
  parseStoredBrowserId,
  withBrowserIdentityQuery,
} from "../src/lib/browser-identity";
import { apiFetch } from "../src/lib/client";

const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("parseStoredBrowserId", () => {
  test("keeps a UUID and drops anything else", () => {
    expect(parseStoredBrowserId(ID)).toBe(ID);
    expect(parseStoredBrowserId("not-a-uuid")).toBeNull();
    expect(parseStoredBrowserId(null)).toBeNull();
  });

  test("is stored under a namespaced key, not a bare id", () => {
    expect(BROWSER_ID_STORAGE_KEY).not.toBe(ID);
    expect(BROWSER_ID_STORAGE_KEY.startsWith("openbot.")).toBe(true);
  });
});

describe("withBrowserIdentityQuery", () => {
  test("adds the browser id without dropping an existing query", () => {
    const url = withBrowserIdentityQuery(
      "ws://localhost:3001/api/channels/events?keep=1",
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("keep")).toBe("1");
    expect(parsed.searchParams.get(BROWSER_ID_QUERY)).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });
});

describe("apiFetch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends the remembered browser id on every request", async () => {
    let sent: Headers | undefined;
    globalThis.fetch = (async (_url, init) => {
      sent = new Headers(init?.headers);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await apiFetch("/api/me");
    expect(sent?.get(BROWSER_ID_HEADER)).toBe(getBrowserId());
    expect(sent?.get(BROWSER_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
