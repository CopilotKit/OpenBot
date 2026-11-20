import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// The server keeps no text with a NUL in it ("That text has a character OpenBot can't keep"), and
// the spec says so with patterns that refuse it. A pattern that refuses NUL anywhere must refuse it
// everywhere: `^[^\x00]*\S[^\x00]*$` let its one non-space character be a NUL, because `\S` matches
// one, so a request the server refuses read as valid to every client and test generated from it.

const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
  { maxAliasCount: -1 },
);

/** Every `pattern` in the spec, by where it is. */
function patterns(node: unknown, where = ""): [string, string][] {
  if (Array.isArray(node))
    return node.flatMap((item, index) => patterns(item, `${where}/${index}`));
  if (!node || typeof node !== "object") return [];
  return Object.entries(node as Record<string, unknown>).flatMap(
    ([key, value]): [string, string][] =>
      key === "pattern" && typeof value === "string"
        ? [[where, value]]
        : patterns(value, `${where}/${key}`),
  );
}

// Text with a NUL in it, beside what each pattern takes otherwise: a single character, a prefixed
// scope (`team:`, `group:`), or nothing else.
const WITH_NUL = [
  "\u0000",
  "a\u0000",
  "\u0000a",
  "team:\u0000",
  "group:\u0000",
];

test("no pattern that keeps NUL out lets one through", () => {
  const refusingNul = patterns(spec).filter(([, pattern]) =>
    pattern.includes("[^\\x00]"),
  );
  expect(refusingNul.length).toBeGreaterThan(0);
  const lets = refusingNul.flatMap(([where, pattern]) =>
    WITH_NUL.filter((text) => new RegExp(pattern, "u").test(text)).map(
      (text) => `${where}: ${pattern} takes ${JSON.stringify(text)}`,
    ),
  );
  expect(lets).toEqual([]);
});
