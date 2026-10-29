// app/tests/search-text.test.ts
/**
 * Search parameters that are TEXT survive the router's JSON parsing.
 *
 * The router JSON-parses every search value, so `?flow_id=12345` reaches a route as the number
 * 12345 and `?flow_id={"a":1}` as an object. A route that guarded on `typeof value === "string"`
 * dropped exactly those, which for the OAuth return leg's `flow_id` means the correlation handle
 * vanishes for whichever ids the vendor's generator happens to emit: green in testing, and a return
 * leg bound to nothing for a fraction of real ids in production.
 *
 * Two halves are pinned here. `searchText` renders whatever arrived back to the text it was, and
 * `parseSearchText` takes away the one case it could not have rendered back exactly — a number too
 * long to survive a double.
 */
import { expect, test } from "bun:test";
import {
  parseSearchText,
  searchText,
  searchTextEntry,
} from "@/lib/search-text";

test("text is recovered from whatever the router parsed the value into", () => {
  expect(searchText("abc")).toBe("abc");
  expect(searchText(12345)).toBe("12345");
  expect(searchText(true)).toBe("true");
  expect(searchText(null)).toBe("null");
  expect(searchText({ a: 1 })).toBe('{"a":1}');
  expect(searchText(["a"])).toBe('["a"]');
  // Present and empty is a value, not an absence; only an absent parameter is undefined.
  expect(searchText("")).toBe("");
  expect(searchText(undefined)).toBeUndefined();
});

test("the entry carries the key or omits it, never sets it to undefined", () => {
  expect(searchTextEntry("flow_id", 12345)).toEqual({ flow_id: "12345" });
  expect(searchTextEntry("flow_id", undefined)).toEqual({});
  expect("flow_id" in searchTextEntry("flow_id", undefined)).toBe(false);
});

/*
 * ROUND TRIP, which is the whole claim: what the verifier put in the URL is what a route reads.
 * `parseSearchText` is the router's own parsing, so this is the real path a browser takes.
 */
test("a handle survives the URL whatever it is made of", () => {
  const handles = [
    "fl_01HQ8Z",
    "12345",
    "0123",
    "1e3",
    "12345678901234567890",
    '{"a":1}',
    "true",
    "null",
    "a b&c/../d",
  ];
  for (const handle of handles) {
    const url = `?flow_id=${encodeURIComponent(handle)}`;
    expect(searchText(parseSearchText(url).flow_id)).toBe(handle);
  }
});

test("a parameter that is not there stays not there", () => {
  expect(searchText(parseSearchText("?other=1").flow_id)).toBeUndefined();
});
