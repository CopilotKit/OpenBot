// server/tests/sole-definition.test.ts
/**
 * Guard: a decision that has been named once has EXACTLY ONE DEFINITION in this repo.
 *
 * WHY THIS EXISTS. The recurring defect across both review rounds is not a wrong line; it is a
 * right line that never reached its siblings. A fix lands at the site the reviewer pointed at, the
 * same decision stays spelled out two files away, and the next round finds it again. A round-1 DRY
 * sweep already REPORTED exactly this — `scopesOf` written four times, the brokered-provenance test
 * written in three places — and a report is not a check: nothing failed, so nothing changed, and
 * the duplicates are all still here to be read below.
 *
 * So the report is made BINDING. Each entry in {@link TRACKED} names a decision and every spelling
 * it currently answers to; the scan collects every definition of those spellings across the repo's
 * sources and compares the list against what is recorded. A symbol with no entry in
 * {@link KNOWN_DUPLICATES} must have exactly one definition. A symbol with an entry must have
 * exactly the definitions recorded there — not fewer and not more. Both directions matter:
 *
 *   - MORE fails the day somebody re-spells a tracked decision in a fifth file, which is the defect
 *     this exists to stop.
 *   - FEWER fails the day the fix cycle collapses a duplicate, which is not a regression but does
 *     mean the list is now stale. The failure says so and names the site to delete. That is how the
 *     list burns down to empty instead of quietly outliving the debt it records.
 *
 * LANDING GREEN IS DELIBERATE. Every duplicate standing today is recorded in {@link KNOWN_DUPLICATES}
 * with the finding that owns it, so this guard is green on arrival and collapsing the duplicates
 * stays with the fix cycle where a reviewer can see each merge argued for. A guard that lands red
 * gets skipped; a guard that lands green and goes red on the next re-spelling gets read.
 *
 * WHAT THE PATTERN SEES, AND WHAT IT DOES NOT. A definition is a `function`, `const`, `let`, `var`
 * or `class` binding of the name, through the shared scanner so comments are blanked (a `{@link
 * scopesOf}` in a docblock is prose, not a home) and a prettier-wrapped definition is still one
 * line. It does NOT see a name bound as an object property (`{ scopesOf: (x) => … }`), a method, or
 * a re-export alias: those spellings do not occur for the tracked names today, and widening the
 * pattern speculatively would buy false positives on every unrelated `scopesOf:` key. The names
 * list is the escape hatch instead — a decision re-spelled under a NEW name, like `isBrokered` for
 * `brokeredProvenance`, is added as an alias of the decision it duplicates, which is the only
 * reason an alias list exists at all.
 *
 * TEST FILES ARE NOT SCANNED. A `const lookup = async (hash) => …` inside a test is a fixture with
 * a short life and a local meaning, not a second home for a production decision.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  logicalLines,
  sourceFiles,
  stripComments,
} from "./support/source-scan";

const REPO = join(import.meta.dir, "../..");

/** The source trees a production decision can live in. Tests are excluded below, by file name. */
const ROOTS = [
  "app/src",
  "server/src",
  "shared",
  "worker",
  "scripts",
  "desktop/src",
  "mobile/src",
];

/**
 * A decision, every name it is currently spelled under, and — for one that is NOT in
 * {@link KNOWN_DUPLICATES} — the single file that is its home.
 *
 * The home is written down rather than inferred so the failure reads as a diff of two file lists:
 * "expected [lookup.ts], received [lookup.ts, access.ts]" names the offending file, where a bare
 * length assertion would only say "expected 1, received 2" and leave the reader to go find it.
 */
type Tracked = { decision: string; names: string[]; home?: string };

const TRACKED: Tracked[] = [
  /*
   * Is this row's provenance a broker's? Spelled as a named predicate twice and open-coded as the
   * same two-arm literal comparison a third time, under a different name, on the page that lists
   * the accounts those rows produce.
   */
  {
    decision: "brokered-provenance",
    names: ["brokeredProvenance", "isBrokered"],
  },
  /*
   * The scopes a grant/tool/config carries, read out of a shape whose field is not guaranteed.
   * Four definitions, three of them in the plugins directory.
   */
  { decision: "scopes-of", names: ["scopesOf"] },
  /*
   * The prototype-safe keyed read extracted by CL-6. Tracked from the day it lands, so the table
   * lookup never acquires a second home the way the two above did.
   */
  {
    decision: "keyed-lookup",
    names: ["keyedLookup"],
    home: "app/src/lib/lookup.ts",
  },
  /*
   * Decisions this cycle made single-source, tracked by NAME from here on (lever L5). Each had
   * exactly one definition when this landed. A name entry stops the decision being re-DEFINED under
   * the same name; a re-spelling of its BODY under another name is what {@link SPELLED} below is for.
   */
  /* The three sibling-cascade rules, extracted in round 2 (A5) and routed to by all callers (A5a). */
  {
    decision: "sibling-cascade-rules",
    names: ["clearEndedSiblings"],
    home: "server/src/plugins/plugin-store/context.ts",
  },
  /*
   * Rule 1's one spelling, the sibling judgement without the delete, and the asked app's trail
   * claim — the three K5 made single-source so the trail and the deletion judge a key app once.
   */
  {
    decision: "consent-revoke-reaches",
    names: ["consentRevokeReaches"],
    home: "server/src/plugins/plugin-store/context.ts",
  },
  {
    decision: "siblings-ended-by",
    names: ["siblingsEndedBy"],
    home: "server/src/plugins/plugin-store/context.ts",
  },
  {
    decision: "vendor-revocation-claim",
    names: ["vendorRevocationClaim"],
    home: "server/src/plugins/plugin-store/context.ts",
  },
  /* Which apps a revoke ends besides the one it names: "the one place that answers it". */
  {
    decision: "sibling-resolution",
    names: ["resolveSiblings"],
    home: "server/src/plugins/plugin-store/context.ts",
  },
  /* Whether an app is a key, consent or neither, read off `mcp_servers`; every rule 1 asks it. */
  {
    decision: "brokered-app-kind",
    names: ["brokeredAppKind"],
    home: "server/src/plugins/plugin-store/context.ts",
  },
  /* The migrator's journal table, named once (C4). Its literal spellings are in SPELLED below. */
  {
    decision: "migrations-journal",
    names: ["MIGRATIONS_JOURNAL"],
    home: "server/src/db/apply-migrations.ts",
  },
  /* The migrator's high-water mark, "the single source for the mark" (C3). */
  {
    decision: "migrator-high-water-mark",
    names: ["migratorHighWaterMark"],
    home: "server/src/db/migration-reach.ts",
  },
];

/**
 * The duplicates standing when this guard landed, each with the finding that owns collapsing it.
 *
 * Keyed by decision. The list is the debt, written down: when a finding below is fixed, its sites
 * come out of this list in the same commit, and the guard goes red if they do not.
 */
const KNOWN_DUPLICATES: Record<
  string,
  { finding: string; why: string; sites: string[] }
> = {
  "brokered-provenance": {
    finding: "round-1 DRY sweep (`brokeredProvenance` defined 2x) + G-series",
    why: "One predicate for the app and one for the server, plus the same two-arm literal open-coded as `isBrokered` on the connected-accounts page; collapsing them is a cross-package move the fix cycle owns.",
    sites: [
      "app/src/lib/plugins/provider-vocabulary.ts",
      "app/src/routes/_authed/_app/connections.index.tsx",
      "server/src/plugins/access.ts",
    ],
  },
  "scopes-of": {
    finding: "round-1 DRY sweep (`scopesOf` defined 4x)",
    why: "Four readers of the same `scopes` field with four input shapes; merging them means agreeing one shape, which is a behavioural decision and stays in the fix cycle.",
    sites: [
      "app/src/lib/plugins/grants.ts",
      "server/src/plugins/arcade-adapter.ts",
      "server/src/plugins/arcade.ts",
      "server/src/plugins/composio-vendor.ts",
    ],
  },
};

/** A binding of `name`, not a call of it and not a mention of it in prose. */
function definitionPattern(name: string): RegExp {
  return new RegExp(
    `(?:^|[^.\\w$])(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\s*\\*?|const|let|var|class)\\s+${name}(?![\\w$])`,
  );
}

/** Not a test, not a type declaration: a file a production decision can be defined in. */
function isSource(path: string): boolean {
  return !/\.(test|spec)\.tsx?$|\.d\.ts$/.test(path);
}

/**
 * Every source file in the repo where one of `names` is bound, one entry per binding.
 *
 * PATHS, NOT `path:line`, on purpose. A list carrying line numbers goes red when somebody rewraps
 * a comment three functions above a definition, and a guard that fails for a reason unrelated to
 * what it guards is one people learn to re-baseline without reading. A second definition in the
 * SAME file still shows up, as that path listed twice.
 */
function definitionsOf(names: string[]): string[] {
  const patterns = names.map(definitionPattern);
  const out: string[] = [];
  for (const root of ROOTS) {
    const full = join(REPO, root);
    if (!existsSync(full)) continue;
    for (const file of sourceFiles(full, [".ts", ".tsx"])) {
      if (!isSource(file)) continue;
      for (const { text } of logicalLines(readFileSync(file, "utf8"))) {
        if (patterns.some((re) => re.test(text))) {
          out.push(file.slice(REPO.length + 1));
        }
      }
    }
  }
  return out.sort();
}

for (const { decision, names, home } of TRACKED) {
  test(`"${decision}" has one definition, or exactly the duplicates on record`, () => {
    const found = definitionsOf(names);
    const known = KNOWN_DUPLICATES[decision];
    if (known) {
      // Recorded debt. Equality both ways: a new re-spelling fails, and so does a collapse that
      // did not also delete the site from the list above.
      expect(found).toEqual([...known.sites].sort());
      return;
    }
    // No recorded debt: one home, and the diff names any file that became a second one.
    expect(found).toEqual(home ? [home] : []);
  });
}

/**
 * Every spelling the name scan must catch, and every one it must not.
 *
 * The guard's own positive control plants a duplicate in a real file, which proves the walk reaches
 * it. This proves the other half: that what the walk hands the pattern is read as a definition when
 * it is one and as a call when it is not. Without this, the guard could be green because the
 * pattern matches nothing at all.
 */
test("a definition is matched, and a call or a mention is not", () => {
  const re = definitionPattern("keyedLookup");
  const definitions = [
    "function keyedLookup(map, key) {",
    "export function keyedLookup(map, key) {",
    "  const keyedLookup = (map, key) => map.get(key);",
    "export const keyedLookup = (m, k) => m.get(k);",
    "let keyedLookup;",
    "var keyedLookup = 1;",
    "class keyedLookup {}",
    "export async function keyedLookup(m, k) {",
  ];
  for (const line of definitions) expect(re.test(line)).toBe(true);
  const notDefinitions = [
    "  return keyedLookup(MARKS, key) ?? IconPlug;",
    'import { keyedLookup } from "@/lib/lookup";',
    "const mark = utils.keyedLookup(MARKS, key);",
    " * see {@link keyedLookup} for why this is a Map",
    "const keyedLookupTable = new Map();",
    "function keyedLookupTable() {}",
  ];
  for (const line of notDefinitions) expect(re.test(line)).toBe(false);
});

/*
 * ─── SPELLINGS: a decision re-written under no name at all (lever L5, class K5) ───────────────────
 *
 * The name table above catches a decision DEFINED twice. It cannot catch the shape this cycle kept
 * re-opening: a rule or a name made single-source in one place and then written out again, inline,
 * somewhere that never binds a name to it — `retireConnectionsFor` re-spelling the sibling rules
 * `clearEndedSiblings` owns (A5b), `removeServer` deciding a key app's revoke answer its own way
 * where `disconnectBrokered` already had (A5c), a migrations-table name chosen by a tool's default
 * where `MIGRATIONS_JOURNAL` had already chosen it (C4n).
 *
 * So each entry below is a decision and the TEXT that spells it: a pattern matched against every
 * logical line of every source file, comments stripped first, so prose that DESCRIBES the rule (and
 * this codebase describes its rules at length) is not a spelling of it. The comparison is the one
 * the name table makes, in the same two directions and keyed the same way — by PATH, a file listed
 * once per logical line that spells the decision — against either the home or the debt on record.
 *
 * WHAT A PATH KEY CANNOT SAY. Two spellings in one file are that path listed twice; which of the two
 * is the home is not something a path can carry. For A5c the second spelling was in the SAME file as
 * the first (`plugin-store/connections.ts`; both A5b and A5c were in `plugins/store.ts` before #784
 * split it; K5 collapsed both into `context.ts`), so the guard holds the COUNT: a second spelling
 * anywhere, the home's own file included, goes red; collapsing one goes red until the list drops a
 * line. Moving the
 * spelling from the owning function into a sibling function of the same file does not. That is the
 * price of not going red on a rewrapped comment, and the same price the name table already pays.
 */

/**
 * The name table's roots, plus the two places a MIGRATION decision is made that a production
 * runtime decision is not: the server's own scripts (`server/scripts/migrate.ts` is what a
 * deployment runs) and `server/drizzle.config.ts` (what `drizzle-kit` reads). The name table's own
 * {@link ROOTS} miss both; widening it is left to whoever owns that list.
 */
const SPELLING_ROOTS = [...ROOTS, "server/scripts", "server/drizzle.config.ts"];

/** Every source file under each root; a root that is a file is itself. */
function spellingFiles(): string[] {
  const out: string[] = [];
  for (const root of SPELLING_ROOTS) {
    const full = join(REPO, root);
    if (!existsSync(full)) continue;
    if (/\.tsx?$/.test(full)) out.push(full);
    else out.push(...sourceFiles(full, [".ts", ".tsx"]));
  }
  return out.filter(isSource);
}

/**
 * A decision, the text that spells it, and — for one with no entry in
 * {@link KNOWN_SECOND_SPELLINGS} — the paths of its home, once per logical line that spells it.
 *
 * The home is a LIST because a decision can rightly take more than one LOGICAL line in its own
 * file. (The journal's schema and table are two physical lines but one logical line: a line ending
 * in `,` is joined to the next by {@link logicalLines}, so the object counts once.)
 */
type Spelled = { decision: string; patterns: RegExp[]; home: string[] };

const SPELLED: Spelled[] = [
  /*
   * The migrator's journal, as a literal. `MIGRATIONS_JOURNAL` is the one place a schema or table
   * name is written; anything else either reads that object or is a second answer to the question
   * the reach check and `migrate()` must answer identically (C4).
   */
  {
    decision: "migrations-journal-literal",
    patterns: [
      /__drizzle_migrations/,
      /\bmigrations(?:Schema|Table)\s*:\s*["'`]/,
      // drizzle-kit's own spelling of the same two fields, in a `migrations: { … }` config block.
      /\bmigrations\s*:\s*\{[^}]*\b(?:schema|table)\s*:\s*["'`]/,
    ],
    home: ["server/src/db/apply-migrations.ts"],
  },
  /*
   * THE SIBLING-CASCADE RULES: which of a revoke's siblings it ended. Spelled as a walk over a
   * {@link resolveSiblings} answer, because every spelling of the three rules is one — rule 1 and
   * rule 3 are each a `continue` inside that walk, rule 2 the guard before it. `siblingsEndedBy`
   * is the one walk (rules 1 and 2); `clearEndedSiblings` adds rule 3 and the delete over its
   * answer, and `retireConnectionsFor` files `endedWith` from the same answer (K5). A site that
   * needs the rules asks one of those rather than walking the set itself.
   */
  {
    decision: "sibling-cascade-walk",
    patterns: [
      /\bfor\s*\(\s*(?:const|let|var)\s+[\w$]+\s+of\s+[^;]*\bsiblings\b/,
      // A MEMBER `.siblings` only: a bare `siblings` local is also how `shared-use-store.ts` names
      // the rows of one app at one url, which is not a revoke's answer and not this decision.
      /\.siblings\s*(?:\?\.|\.)\s*(?:forEach|map|flatMap|filter|reduce|some|every|find)\s*\(/,
    ],
    home: ["server/src/plugins/plugin-store/context.ts"],
  },
  /*
   * WHAT THE TRAIL SAYS WAS ASKED OF THE VENDOR, for the app an act was ABOUT. A key app's answer
   * is `false` — nothing was asked of any vendor about a credential this deployment holds — and
   * `vendorRevocationClaim` spells that once, as a payload fragment every writer of an asked app's
   * row spreads (`disconnectBrokered`, `removeServer`, `retireConnectionsFor`; K5 moved the home
   * here from `disconnectBrokered`'s `askedIsKey ? false : ended`). A writer that computes
   * the field from anything else is a second answer to the same question. A constant `true` or
   * `false` is not a computation and is not matched: `clearEndedSiblings` writes `true` on rows
   * rule 1 has already kept key apps out of, and the vault loops write `false` about secrets.
   */
  {
    decision: "key-app-revoke-answer",
    patterns: [
      /\bvendorRevocationRequested\s*[:=]\s*(?!true\b|false\b|boolean\b)\S/,
    ],
    home: ["server/src/plugins/plugin-store/context.ts"],
  },
];

/**
 * The second spellings standing when L5 landed, each with the open finding that owns collapsing it.
 *
 * THE SAME DISCIPLINE AS `typecheck-baseline.txt`: every site past the home is a real defect, not a
 * thing that is fine. Collapsing one and deleting its line is always correct, and the guard goes red
 * until the line is deleted. Adding a line is not: a new site is code written today re-spelling a
 * decision somebody already made, and this exists to say so.
 */
const KNOWN_SECOND_SPELLINGS: Record<
  string,
  { finding: string; why: string; sites: string[] }
> = {
  /*
   * EMPTY SINCE ROUND 2, K5. Both entries L5 landed with were collapsed into one home each in
   * `plugin-store/context.ts`: "sibling-cascade-walk" (A5b — `retireConnectionsFor`'s own walk,
   * without rule 1) now asks `siblingsEndedBy`, and "key-app-revoke-answer" (A5c, L5-a —
   * `removeServer` and `retireConnectionsFor` passing a key app's raw vendor answer through) now
   * asks `vendorRevocationClaim`, as `disconnectBrokered` does. A new entry here is a new defect.
   */
};

/** Every source file in which one of `patterns` matches a logical line, comments stripped. */
function spellingsOf(patterns: RegExp[]): string[] {
  const out: string[] = [];
  for (const file of spellingFiles()) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const { text } of logicalLines(code)) {
      if (patterns.some((re) => re.test(text))) {
        out.push(file.slice(REPO.length + 1));
      }
    }
  }
  return out.sort();
}

for (const { decision, patterns, home } of SPELLED) {
  test(`"${decision}" is spelled only at its home, or exactly the second spellings on record`, () => {
    const found = spellingsOf(patterns);
    const known = KNOWN_SECOND_SPELLINGS[decision];
    // Recorded debt: equality both ways, as for the name table. With none, the home and only it.
    expect(found).toEqual([...(known ? known.sites : home)].sort());
  });
}

/*
 * ─── IMPLICIT SPELLINGS: a consumer that names nothing, and so takes a tool's default ────────────
 *
 * No pattern can match text that is not there. `drizzle.config.ts` names no migrations table, so
 * `drizzle-kit migrate` uses drizzle-kit's OWN default — which happens today to be the same schema
 * and table `MIGRATIONS_JOURNAL` names, and which nothing in this repository decides. That is a
 * second spelling the literal scan above is blind to by construction (C4n), and the day either side
 * changes, the reach check reads one table and the CLI writes another.
 *
 * So the condition is stated the other way round: every file that hands migrations to a migrator —
 * imports `drizzle-kit`, or a `drizzle-orm/<driver>/migrator` — must REFERENCE the constant in code.
 * One that does not is taking somebody else's default. Consumers are discovered, not listed, so a
 * new migrator entry point is held to this the day it lands.
 */
const JOURNAL_CONSUMER =
  /\bfrom\s+["'](?:drizzle-kit|drizzle-orm\/[\w-]+\/migrator)["']/;
const JOURNAL_REFERENCE = /\bMIGRATIONS_JOURNAL\b/;

/** Consumers that take a default instead of naming the journal, recorded as the debt they are. */
const KNOWN_DEFAULT_TAKERS: { finding: string; sites: string[] } = {
  finding: "C4n (round 2, wave 3) — open",
  sites: ["server/drizzle.config.ts"],
};

/** Every migrator consumer whose CODE (comments stripped) never mentions the journal constant. */
function defaultTakers(): string[] {
  const out: string[] = [];
  for (const file of spellingFiles()) {
    const code = stripComments(readFileSync(file, "utf8"));
    if (JOURNAL_CONSUMER.test(code) && !JOURNAL_REFERENCE.test(code)) {
      out.push(file.slice(REPO.length + 1));
    }
  }
  return out.sort();
}

test("every migrator consumer names MIGRATIONS_JOURNAL, or is a default-taker on record", () => {
  expect(defaultTakers()).toEqual([...KNOWN_DEFAULT_TAKERS.sites].sort());
});

/**
 * The spelling patterns' own positive and negative controls, for the reason the name pattern has
 * one: a guard can be green because its pattern matches nothing at all.
 */
test("a spelling is matched, and a mention, a read or a type is not", () => {
  const cases: Record<string, { spells: string[]; doesNot: string[] }> = {
    "migrations-journal-literal": {
      spells: [
        '  migrationsTable: "__drizzle_migrations",',
        '  migrationsSchema: "drizzle",',
        'migrations: { schema: "drizzle", table: "journal" },',
        "select * from drizzle.__drizzle_migrations",
      ],
      doesNot: [
        "  migrationsSchema: string;",
        "  migrations: { schema: MIGRATIONS_JOURNAL.migrationsSchema },",
        "from client(MIGRATIONS_JOURNAL.migrationsTable)",
      ],
    },
    "sibling-cascade-walk": {
      spells: [
        "for (const app of new Set(input.siblings)) {",
        "for (const app of endedBesides.get(entry.toolkit)?.siblings ?? []) {",
        "for (let app of siblings) {",
        "resolved.siblings.forEach((app) => {",
        "input.siblings.filter((app) => app !== toolkit)",
      ],
      doesNot: [
        "await clearEndedSiblings({ siblings, account, endedWith: toolkit });",
        "siblings: input.siblings,",
        "const { siblings, unanswered } = await resolveSiblings(x);",
        "for (const connection of brokered) {",
        "const ids = siblings.map((sibling) => sibling.id);",
      ],
    },
    "key-app-revoke-answer": {
      spells: [
        "const vendorRevocationRequested = askedIsKey ? false : ended;",
        "vendorRevocationRequested: vendorRevocationRequested[index] ?? false,",
        "vendorRevocationRequested: connection.requested || Boolean(endedBy),",
        "vendorRevocationRequested: ended,",
      ],
      doesNot: [
        "vendorRevocationRequested: true,",
        "vendorRevocationRequested: false,",
        "}): Promise<{ vendorRevocationRequested: boolean }> {",
        "const vendorRevocationRequested: boolean[] = [];",
        "vendorRevocationRequested?: boolean;",
        "return { vendorRevocationRequested };",
      ],
    },
  };
  for (const { decision, patterns } of SPELLED) {
    const { spells, doesNot } = cases[decision] ?? { spells: [], doesNot: [] };
    // Every entry has controls: an entry added without them fails here rather than going unproven.
    expect(spells.length).toBeGreaterThan(0);
    for (const line of spells) {
      expect({
        decision,
        line,
        hit: patterns.some((re) => re.test(line)),
      }).toEqual({
        decision,
        line,
        hit: true,
      });
    }
    for (const line of doesNot) {
      expect({
        decision,
        line,
        hit: patterns.some((re) => re.test(line)),
      }).toEqual({
        decision,
        line,
        hit: false,
      });
    }
  }
  expect(
    JOURNAL_CONSUMER.test('import { defineConfig } from "drizzle-kit";'),
  ).toBe(true);
  expect(
    JOURNAL_CONSUMER.test(
      'import { migrate } from "drizzle-orm/postgres-js/migrator";',
    ),
  ).toBe(true);
  expect(
    JOURNAL_CONSUMER.test('import { drizzle } from "drizzle-orm/postgres-js";'),
  ).toBe(false);
});
