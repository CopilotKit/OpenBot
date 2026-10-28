// server/tests/brokered-provenance.test.ts
/**
 * Guard: no plugin module outside the three VOCABULARY modules may spell a brokered vendor's name —
 * in a provenance or provider comparison, or in a url scheme it builds.
 *
 * `access.ts`, `composio.ts` and `arcade.ts` are the exempt files. `access.ts` is where the shared
 * vocabulary lives — {@link BrokerProvider}, {@link brokeredProvenance}, `TOOLKIT_OF` and
 * `BROKERED_PROFILE`, which is why the scheme literals are there and not in `store.ts`. The other
 * two are each one broker's own module, and a module whose whole job is to speak one vendor's
 * protocol has to be able to spell that vendor's scheme and define that vendor's parser. Neither
 * trips the provenance patterns today, and neither is exempt from anything it does not need:
 * widening the list is what makes the scheme pattern absolute everywhere else, instead of a pattern
 * with a per-line escape hatch — and an escape hatch in a guard is the thing that gets used the
 * second time without the argument being made again.
 *
 * COMMENT LINES ARE SKIPPED, DELIBERATELY AND NARROWLY. A line whose trimmed start is `*`, `//` or
 * `/*` is not scanned. `store.ts` alone carries about a dozen `composio://` mentions inside
 * docblocks — "a row called `gmail` at `composio://slack`" and the like — which are explanation of
 * why a rule exists, not an instance of breaking it. A SCHEME NAMED IN PROSE IS DOCUMENTATION; A
 * SCHEME NAMED IN AN EXPRESSION IS A DECISION. The skip is on the line's syntactic position and
 * nothing else, so it cannot grow: the alternative — loosening the pattern until the docblocks stop
 * matching — would also stop it matching the thing it is for, which is a string carrying a scheme.
 *
 * The offenders are collected into a list and compared against `[]` rather than asserted one file at
 * a time, so a new site has to be argued for here rather than quietly allowed.
 *
 * THE FOURTH PATTERN FAMILY IS THE PARSER CALL, AND IT IS ARMED. A direct call to a vendor module's
 * own parser — `toolkitOf(url)` rather than `toolkitOfFor(provider, url)` — is the same mistake as a
 * spelled scheme, reached one step further in: it does not name a vendor, it IS one, and it answers
 * null for every url the other broker mints rather than failing. What that bought on an Arcade
 * deployment was four different wrong answers from one wrong parser, none of which read as a parser
 * problem — an app refused as "not reached through a broker", a directory offering to enable what
 * was already enabled, a connect route falling past its own brokered branch, and an authorize,
 * grants and disconnect that all refused a connected app.
 *
 * WHAT THE ARMED PATTERN NOW GUARANTEES: outside the three vocabulary modules, no plugin module
 * calls `toolkitOf` at all. Every brokered url in `src/plugins` is parsed through
 * `toolkitOfFor(provider, url)`, with the provider handed in rather than sniffed — so adding a
 * broker changes the dispatch table in `access.ts` and nothing else, and a module that reaches past
 * the dispatch for one vendor's parser is named here before it ships. The only lines the pattern
 * still matches are the definitions themselves, in the three exempt modules it does not scan.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { logicalLines, sourceFiles } from "./support/source-scan";

const PLUGINS_DIR = join(import.meta.dir, "../src/plugins");

/** The modules allowed to speak a broker's vocabulary. Every other plugin module asks them. */
const VOCABULARY = new Set(["access.ts", "composio.ts", "arcade.ts"]);

const PATTERNS: RegExp[] = [
  /provenance\s*[!=]==\s*"(composio|arcade)"/,
  /brokeredConnections\.provider\s*,\s*"(composio|arcade)"/,
  /provider:\s*"(composio|arcade)"/,
  // `eq(mcpServers.provenance, "composio")`: the drizzle spelling of the same mistake as the
  // `provenance === "composio"` pattern above. A guard catching one spelling of a mistake and not
  // the other is worse than none, because it is read as coverage.
  /(mcpServers|\w+)\.provenance\s*,\s*"(composio|arcade)"/,
  // A scheme spelled into a string — the construction half. `composio://${toolkit}` in `store.ts`
  // is what dropped every Arcade connection off the settings page and what sent an Arcade
  // deployment's probe to Composio; the scheme comes out of `BROKERED_PROFILE` now.
  /["'`](composio|arcade):\/\//,
  // A vendor module's own parser called directly, not the dispatch. `toolkitOf(url)` reads one
  // broker's scheme and answers null for the other's, so a module holding the active provider must
  // ask `toolkitOfFor(provider, url)` instead.
  /\btoolkitOf\s*\(/,
];

/** A line of prose rather than a line of code. See the docblock: the skip is narrow on purpose. */
function isComment(line: string): boolean {
  const start = line.trimStart();
  return (
    start.startsWith("*") || start.startsWith("//") || start.startsWith("/*")
  );
}

test("no plugin module hard-codes a brokered vendor name outside the vocabulary modules", () => {
  const offenders: string[] = [];
  // The shared scanner's walk and line-splitting. RECURSIVE: a `src/plugins/<dir>/x.ts` was
  // unscanned before, and the exemption is by FILE NAME, so a `plugins/<dir>/access.ts` is not
  // quietly exempt either. LOGICAL lines: a scheme prettier wrapped off its own `=` is one
  // decision, and reading it per physical line saw half of it. The comment skip is unchanged and
  // still narrow — only a line that STARTS as prose is spared.
  const files = sourceFiles(PLUGINS_DIR, [".ts"]).filter(
    (f) => !VOCABULARY.has(basename(f)),
  );
  for (const file of files) {
    for (const { line, text } of logicalLines(readFileSync(file, "utf8"))) {
      if (isComment(text)) continue;
      if (PATTERNS.some((re) => re.test(text))) {
        offenders.push(`${file.slice(PLUGINS_DIR.length + 1)}:${line}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

/**
 * And the comment skip does not also skip code, which is the one way this guard could go quietly
 * useless. Each line below is an offender the scan must still name, including the ones that carry a
 * comment — a trailing `//` does not make a line prose, and only a line that STARTS as prose is
 * skipped.
 */
test("the comment skip takes prose and leaves every expression", () => {
  const code = [
    // Interpolation is spelled by concatenation here only so the linter does not read a template
    // placeholder inside a plain string as a mistake; what the pattern sees is the same line.
    `const url = \`composio://$\{toolkit}\`;`,
    `const url = \`arcade://$\{toolkit}\`; // the scheme`,
    '    return { url: "composio://gmail" };',
    '\tif (row.provenance === "arcade") return null;',
    'const u = "composio://" + toolkit; /* trailing block */',
    "    const toolkit = row ? toolkitOf(row.url) : null;",
  ];
  const prose = [
    " * a row called `gmail` at `composio://slack` would decide a Slack confirm",
    "// `arcade://Gmail` and `arcade://gmail` are distinct apps.",
    "/* `composio://` is the scheme the rows are minted at. */",
    '  * `provenance === "composio"` was the comparison this replaced.',
    " * `enabled` comes off `toolkitOf(url)` and never off the row's id.",
  ];
  for (const line of code) {
    expect(isComment(line)).toBe(false);
    expect(PATTERNS.some((re) => re.test(line))).toBe(true);
  }
  for (const line of prose) {
    // Prose that WOULD match: the skip is what spares it, not a gap in the patterns.
    expect(PATTERNS.some((re) => re.test(line))).toBe(true);
    expect(isComment(line)).toBe(true);
  }
});
