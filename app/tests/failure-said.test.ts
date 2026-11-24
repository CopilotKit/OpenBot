import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * No page draws an error's own words straight into the page.
 *
 * A failure said in the error's own words (`{save.error.message}`) is drawn in the red the app keeps
 * for what failed. While OpenBot moves an organization, or its database is out of reach, the server
 * answers 503 with a sentence for people and Retry-After: that is not a failure, and the sentence is
 * to be drawn calm. Memory drew it in red because it drew `memories.error.message` itself (found by
 * the end-to-end test of database sharding). `failureSaid(error)` (lib/load-failure.tsx) draws the
 * same words for a real failure and the server's sentence calmly for a hold, so every place draws an
 * error's words through it, and this test finds any that doesn't.
 *
 * What it finds: an error's `.message` as the whole of a JSX child (`{x.error.message}`,
 * `{error?.message}`), or as the start or end of an `||`/`??` choice inside one.
 */
const SRC = join(import.meta.dir, "..", "src");

/** The primitives draw what they are given (a form's field errors), not a server's answer. */
const OUTSIDE = [join(SRC, "components", "ui")];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return OUTSIDE.includes(path) ? [] : sources(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

const ERROR_MESSAGE = String.raw`[A-Za-z_$][\w$.]*[eE]rror\??\.message`;
/** `{ x.error.message }`, `{x.error?.message || ...`, `... ?? x.error.message}` as a JSX child. */
const RAW = new RegExp(
  String.raw`>\s*\{\s*${ERROR_MESSAGE}\s*(\}|\|\||\?\?)|(\|\||\?\?)\s*${ERROR_MESSAGE}\s*\}\s*<|^\s*\{\s*${ERROR_MESSAGE}\s*(\}|\|\||\?\?)`,
  "m",
);

describe("an error's own words", () => {
  test("are drawn through failureSaid on every page", () => {
    const raw: string[] = [];
    for (const file of sources(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (RAW.test(line))
          raw.push(`${relative(SRC, file)}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(raw).toEqual([]);
  });

  test("the scan finds the shapes it is meant to", () => {
    for (const line of [
      "          {memories.error.message}",
      "          {review.error?.message}",
      '          {bots.error?.message || "Couldn\'t load your Bots."}',
      "<p>{delivery.error.message}</p>",
    ])
      expect({ line, found: RAW.test(line) }).toEqual({ line, found: true });
    for (const line of [
      "          {failureSaid(memories.error)}",
      "    error: error ? error.message : null,",
      "  return error instanceof Error ? error.message : String(error);",
    ])
      expect({ line, found: RAW.test(line) }).toEqual({ line, found: false });
  });
});
