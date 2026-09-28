import { describe, expect, test } from "bun:test";
import {
  BROWSER_ID_HEADER,
  BROWSER_ID_QUERY,
  browserIdFromRequest,
  browserUserEmail,
  browserUserId,
  parseBrowserId,
} from "./browser-identity";

const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("parseBrowserId", () => {
  test("accepts a UUID and lowercases it", () => {
    expect(parseBrowserId(ID.toUpperCase())).toBe(ID);
  });

  test("rejects empty, truncated, and non-UUID values", () => {
    expect(parseBrowserId(undefined)).toBeNull();
    expect(parseBrowserId("")).toBeNull();
    expect(parseBrowserId("not-a-uuid")).toBeNull();
    expect(parseBrowserId("dev-local-user")).toBeNull();
    expect(parseBrowserId(`${ID} extra`)).toBeNull();
  });
});

describe("browser user identity", () => {
  test("is namespaced so it cannot collide with a signed-in person", () => {
    expect(browserUserId(ID)).toBe(`browser-${ID}`);
    expect(browserUserEmail(ID)).toBe(`browser-${ID}@openbot.local`);
  });
});

describe("browserIdFromRequest", () => {
  test("reads the header first", () => {
    const request = new Request(
      `http://openbot.test/?${BROWSER_ID_QUERY}=11111111-1111-4111-8111-111111111111`,
      {
        headers: { [BROWSER_ID_HEADER]: ID },
      },
    );
    expect(browserIdFromRequest(request)).toBe(ID);
  });

  test("falls back to the query, which is how a WebSocket identifies itself", () => {
    const request = new Request(
      `http://openbot.test/api/channels/events?${BROWSER_ID_QUERY}=${ID}`,
    );
    expect(browserIdFromRequest(request)).toBe(ID);
  });

  test("ignores a garbage header rather than inventing a person from it", () => {
    const request = new Request("http://openbot.test/", {
      headers: { [BROWSER_ID_HEADER]: "nope" },
    });
    expect(browserIdFromRequest(request)).toBeNull();
  });
});
