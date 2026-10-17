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
 * long to survive a double. The guard at the bottom keeps the `typeof` form from coming back.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSearchText,
  searchText,
  searchTextEntry,
} from "@/lib/search-text";
import {
  logicalLines,
  sourceFiles,
} from "../../server/tests/support/source-scan";

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

/**
 * AND THE SHAPE THAT CAUSED IT DOES NOT COME BACK. A `typeof search.x === "string"` test in a
 * route's `validateSearch` is the defect itself: it reads "keep it when it is text" and means "drop
 * it whenever the sender's value happened to be valid JSON". Routes read text through `searchText`.
 */
const ROUTES_DIR = join(import.meta.dir, "../src/routes");
const DROPPED_STRING = /typeof\s+search\??\.\w+\s*===\s*["']string["']/;

test("no route reads a search parameter by guarding on its parsed type", () => {
  // The walk and the line-splitting are the shared scanner's (server/tests/support): recursive,
  // and LOGICAL lines — prettier wraps `typeof search.flowId ===` away from its `"string"`, and
  // read one physical line at a time this guard would have reported green on the very shape it
  // exists to catch.
  const files = sourceFiles(ROUTES_DIR, [".ts", ".tsx"]);
  expect(files.length).toBeGreaterThan(10);
  const offenders: string[] = [];
  for (const file of files) {
    for (const { line, text } of logicalLines(readFileSync(file, "utf8"))) {
      if (DROPPED_STRING.test(text)) {
        offenders.push(`${file.slice(ROUTES_DIR.length + 1)}:${line}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
