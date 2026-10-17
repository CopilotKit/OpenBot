// server/tests/ts-expect-error-coverage.test.ts
/**
 * Guard: every test file under `server/tests` that carries a ts-expect-error directive must be named
 * in `server/tsconfig.json`'s `include`.
 *
 * AN UNINCLUDED DIRECTIVE IS NOT A WEAKER ASSERTION, IT IS NO ASSERTION. The directive says "the next
 * line must fail to compile", and the only thing that ever checks that is `tsc`. `include` names
 * `src`, `scripts` and a handful of test files, and the rest of `tests` is type-checked by nothing,
 * so a directive in a file not named there sits in the source asserting nothing while reading to the
 * next maintainer as coverage. The wrong-way-round call it guards can compile cleanly for good and no
 * one hears about it.
 *
 * So the convention is: a test file whose subject is a TYPE is named in `include`, one file and not
 * the directory (see the comment in the tsconfig). This guard is what makes that enforceable rather
 * than remembered. It fails naming each file that is not covered, as `file:line`.
 *
 * Like `brokered-provenance.test.ts` it reads text and imports nothing from the code it guards. The
 * tsconfig is JSONC (its comments are the point), so the comments are stripped with a scan that
 * respects strings before it is parsed.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { sourceFiles, stripComments } from "./support/source-scan";

const SERVER_DIR = resolve(import.meta.dir, "..");
const TESTS_DIR = join(SERVER_DIR, "tests");

/** The directive, in either comment form. A bare mention in prose does not match. */
const DIRECTIVE = /(\/\/|\/\*)\s*@ts-expect-error\b/;

function readInclude(): string[] {
  const raw = readFileSync(join(SERVER_DIR, "tsconfig.json"), "utf8");
  // The shared stripper does the JSONC: it leaves string contents (and their slashes) alone, and
  // blanks a comment in place rather than deleting it, which JSON.parse does not care about and a
  // reader comparing the text to the file does.
  const include = JSON.parse(stripComments(raw)).include;
  if (!Array.isArray(include)) throw new Error("tsconfig.json has no include");
  return include.map((p: string) => resolve(SERVER_DIR, p));
}

/** Covered when named exactly, or when it sits under an included directory. */
function isCovered(file: string, include: string[]): boolean {
  return include.some((p) => file === p || file.startsWith(`${p}/`));
}

test("every test file carrying a ts-expect-error directive is named in tsconfig include", () => {
  const include = readInclude();
  const offenders: string[] = [];
  // The shared scanner's walk. Its comment stripper is used above for the JSONC and deliberately
  // NOT here: the directive IS a comment, and it binds to the physical line below it, so this is
  // the one scan that stays on physical lines rather than logical ones.
  for (const file of sourceFiles(TESTS_DIR, [".ts", ".tsx"])) {
    if (isCovered(file, include)) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (DIRECTIVE.test(line)) {
          offenders.push(`${relative(SERVER_DIR, file)}:${i + 1}`);
        }
      });
  }
  expect(offenders).toEqual([]);
});

test("the directive pattern takes both comment forms and leaves prose", () => {
  // The fixtures are assembled so this file does not itself contain the directive it scans for.
  const d = "@ts-expect" + "-error";
  expect(DIRECTIVE.test(`    // ${d} the call`)).toBe(true);
  expect(DIRECTIVE.test(`x(); /* ${d} */`)).toBe(true);
  expect(
    DIRECTIVE.test(" * the ts-expect-error directive is checked by tsc"),
  ).toBe(false);
});
