// server/tests/broker-stub-ratchet.test.ts
/**
 * Ratchet: no NEW test double gets past the broker or credential type by a cast, and no NEW
 * `revokeAccount` stub silently succeeds.
 *
 * WHY THIS EXISTS. `typecheck:tests` (CL-4) type-checks `server/tests` and fails on any new error,
 * but a cast is not an error. `{ … } as unknown as ConnectedAppBroker` and `{} as
 * ConnectedAppBroker` compile while omitting `revoke` and `revokeAccount`; `{ broker } as never`
 * compiles while omitting everything. Each one makes the type's guarantee vanish exactly as the
 * broken `import type` that round-2 C8 fixed did — the same defect by a different mechanism, and
 * one the compiler gate is structurally blind to. A `revokeAccount: async () => {}` stub is the
 * runtime half of the same drift: it type-checks, and answers "done" for a revoke that never
 * happened, on the seam this PR's Claim 2 is about.
 *
 * THE LISTS BELOW ARE A RECORD OF DEBT, in the discipline of `typecheck-baseline.txt`: every entry
 * is a real stub the compiler cannot see, not a stub that is fine. Removing one by fixing it is
 * always correct — and REQUIRED, because the comparison is equality both ways, so a fixed site
 * left on the list goes red and names itself for deletion. Adding one is not: a new cast means a
 * double written today escapes the type, and the honest alternative exists
 * (`support/stub-broker.ts`, whose unprovided members throw and record). The migration of the
 * recorded sites onto that factory is deferred to the fix cycle (convergence audit, K3); this
 * file only reads them.
 *
 * KEYED BY PATH + QUOTED EXPRESSION, NEVER `path:line`. A line-keyed list goes red when somebody
 * adds an import above a stub, and a guard that fails for a reason unrelated to what it guards is
 * one people learn to re-baseline without reading (`assertion-shape.test.ts` collided this way in
 * three consecutive waves; `sole-definition.test.ts`, keyed like this, never has). Two identical
 * expressions in one file appear as that entry twice — duplicates are significant.
 *
 * WHAT THE PATTERNS SEE, AND WHAT THEY DO NOT. Comments are blanked by the shared scanner, so a
 * docblock quoting a cast is prose. Matching runs over the whole stripped file with `\s+`, so a
 * cast wrapped across lines is still one cast. NOT seen: a cast to a local alias of the broker type
 * whose name does not end in `Broker` (`type B = ConnectedAppBroker; x as unknown as B`), a stub
 * erased by `as never` whose line names no broker (`deps as never` where `deps` holds one), and a
 * no-op `revokeAccount` written through a named function (`revokeAccount: noop`). Widening to those
 * would flag every `as never` in the suite; the escape hatch is review, and the factory.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles, stripComments } from "./support/source-scan";

const REPO = join(import.meta.dir, "../..");

/**
 * This file is not scanned: its lists QUOTE every recorded site, and its matcher contract spells
 * the offences it must catch, so scanning it would report its own records as new stubs.
 */
const SELF = import.meta.path;
const ROOT = "server/tests";

/** The seam types a double must not be cast to. A name ending in `Broker` covers every alias. */
const SEAM_TYPE =
  "(?:[A-Z][\\w$]*)?(?:Broker|CredentialStore|CredentialSecretReader|CredentialStatusReader|CredentialAdminService)";

/**
 * A type assertion TO a seam type: `as X`, `as unknown as X`, `as any as X`, `as never as X`, and
 * the wrapped forms `as Partial<X>` / `as unknown as Pick<X, …>`. `{} as X` is `as X`.
 */
export const CAST_TO_SEAM = new RegExp(
  `\\bas\\s+(?:(?:unknown|any|never)\\s+as\\s+)?(?:[\\w$]+\\s*<\\s*)?${SEAM_TYPE}(?![\\w$])`,
  "g",
);

/**
 * A broker ERASED rather than cast: an expression that names a broker — the `broker` key or
 * binding, or any identifier ending in `Broker` — asserted to `never`, `any` or `unknown`, within
 * the same statement. The span stops at a `;` or a line break, so an unrelated `as never` further
 * down the file is not attributed to it.
 */
export const ERASED_BROKER =
  /\b(?:broker|[a-z][\w$]*Broker)\b[^;\n]*?\bas\s+(?:never|any|unknown)\b(?!\s+as\b)/g;

/** A `revokeAccount` that succeeds and does nothing: the silent no-op. */
export const NOOP_REVOKE_ACCOUNT =
  /\brevokeAccount\s*(?::\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::\s*[^=]+?)?=>\s*(?:\{\s*\}|undefined\b|void\s+0\b|Promise\.resolve\(\s*\))|(?:async\s+)?\([^)]*\)\s*(?::\s*[^{]+?)?\{\s*\})/g;

/**
 * Every match of `re` across the test tree, as `path :: expression`.
 *
 * The expression is the whole physical line(s) the match spans, whitespace collapsed, so it reads
 * as the stub a reviewer would see and survives reindentation.
 */
export function sitesOf(re: RegExp, root = ROOT): string[] {
  const out: string[] = [];
  for (const file of sourceFiles(join(REPO, root), [".ts", ".tsx"])) {
    if (file === SELF) continue;
    const text = stripComments(readFileSync(file, "utf8"));
    for (const match of text.matchAll(re)) {
      out.push(
        `${file.slice(REPO.length + 1)} :: ${expressionAt(text, match)}`,
      );
    }
  }
  return out.sort();
}

function expressionAt(text: string, match: RegExpMatchArray): string {
  const at = match.index ?? 0;
  const from = text.lastIndexOf("\n", at) + 1;
  const end = text.indexOf("\n", at + match[0].length);
  return text
    .slice(from, end === -1 ? text.length : end)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Casts past the broker type on record. Round-2 C8a's report counted six; the scan finds EIGHT —
 * `store-account-ref.integration` and `store-vendor-vocabulary` were not in that count. Each one
 * compiles whatever it omits, so none is checked against the seam; all are deferred to the fix
 * cycle (K3).
 */
const KNOWN_CASTS: string[] = [
  "server/tests/directory-vendor-sentences.test.ts :: } as unknown as ComposioBroker;",
  "server/tests/routes-arcade-urls.test.ts :: } as unknown as ComposioBroker;",
  "server/tests/routes-vendor-vocabulary.test.ts :: } as unknown as ComposioBroker;",
  "server/tests/store-account-ref.integration.test.ts :: } as unknown as ConnectedAppBroker;",
  "server/tests/store-provider-required.test.ts :: const broker = {} as ConnectedAppBroker;",
  "server/tests/store-toolkit-dispatch.test.ts :: const broker = {} as ConnectedAppBroker;",
  "server/tests/store-vendor-vocabulary.test.ts :: } as unknown as ConnectedAppBroker;",
  "server/tests/vendor-deadline-sync-throw.test.ts :: } as unknown as ComposioBroker;",
];

/** Brokers erased to `never` on record. Same defect, wider: nothing of the seam is checked. */
const KNOWN_ERASED: string[] = [
  'server/tests/arcade-journey.integration.test.ts :: args[29] = { broker, provider: "arcade" } as never;',
  "server/tests/plugin-routes.test.ts :: listApps ? ({ broker: { listApps } } as never) : undefined,",
  'server/tests/provider-selection.test.ts :: const arcadeBroker = { tag: "arcade-broker" } as never;',
  'server/tests/provider-selection.test.ts :: const composioBroker = { tag: "composio-broker" } as never;',
];

/**
 * Silent no-op `revokeAccount` stubs on record. Round-2 C8c counted 21; the scan finds 22. Deferred
 * to the fix cycle (K1/K3).
 */
const KNOWN_NOOP_REVOKES: string[] = [
  "server/tests/account-mode.integration.test.ts :: revokeAccount: async () => {},",
  "server/tests/arcade-attempt-store.integration.test.ts :: revokeAccount: async () => {},",
  "server/tests/arcade-authorize-cancel.test.ts :: revokeAccount: async () => {},",
  "server/tests/arcade-authorize-route.test.ts :: revokeAccount: async () => {},",
  "server/tests/arcade-completion-transaction.integration.test.ts :: revokeAccount: async () => {},",
  "server/tests/arcade-disconnect-cascade.test.ts :: revokeAccount: async () => {},",
  "server/tests/arcade-disconnect-route.test.ts :: revokeAccount: async () => {},",
  "server/tests/arcade-grants-route.test.ts :: revokeAccount: async () => {},",
  "server/tests/arcade-grants-route.test.ts :: revokeAccount: async () => {},",
  "server/tests/arcade-sibling-collateral.test.ts :: revokeAccount: async () => {},",
  "server/tests/arcade-siblings.test.ts :: revokeAccount: async () => {},",
  "server/tests/arcade-verify.test.ts :: revokeAccount: async () => {},",
  "server/tests/composio-grants-for.test.ts :: revokeAccount: async () => {},",
  "server/tests/gate-foreign-provenance-call.test.ts :: revokeAccount: async () => {},",
  "server/tests/gate-grant-is-local.test.ts :: revokeAccount: async () => {},",
  "server/tests/remove-server-foreign-provenance.test.ts :: revokeAccount: async () => {},",
  "server/tests/shared-brokered-routes.test.ts :: revokeAccount: async () => {},",
  "server/tests/shared-brokered-store.integration.test.ts :: revokeAccount: async () => {},",
  "server/tests/shared-gated-mode.integration.test.ts :: revokeAccount: async () => {},",
  "server/tests/shared-wiring.integration.test.ts :: revokeAccount: async () => {},",
  "server/tests/store-account-ref.integration.test.ts :: revokeAccount: async () => {},",
  "server/tests/store-vendor-vocabulary.test.ts :: revokeAccount: async () => {},",
];

test("no new cast past the broker or credential type", () => {
  // Equality both ways: a NEW site is a double written today that escapes the type; a site that
  // is GONE was fixed, and its entry must be deleted above so the record burns down.
  expect(sitesOf(CAST_TO_SEAM)).toEqual([...KNOWN_CASTS].sort());
});

test("no new broker erased to never, any or unknown", () => {
  const erased = sitesOf(ERASED_BROKER).filter(
    (site) => !new RegExp(CAST_TO_SEAM.source).test(site),
  );
  expect(erased).toEqual([...KNOWN_ERASED].sort());
});

test("no new silent no-op revokeAccount stub", () => {
  expect(sitesOf(NOOP_REVOKE_ACCOUNT)).toEqual([...KNOWN_NOOP_REVOKES].sort());
});

/*
 * THE MATCHER CONTRACT. The real-tree comparisons above prove the lists are current; these prove
 * the patterns are read the way the lists assume — that a cast is matched when it is one and a
 * typed binding or a `satisfies` is not. Without them the ratchet could be green because a pattern
 * matches nothing at all.
 */
const B = "ConnectedAppBroker";
const C = "CredentialStore";
const RA = "revokeAccount";
const BK = "broker";

function matches(re: RegExp, text: string): boolean {
  return new RegExp(re.source).test(text);
}

test("a cast to a seam type is matched; a typed binding, a satisfies or a near-name is not", () => {
  const casts = [
    `} as unknown as ${B};`,
    `const broker = {} as ${B};`,
    `} as ${B};`,
    `x as any as ${B}`,
    `x as never as Composio${"Broker"}`,
    `x as Partial<${B}>`,
    `x as unknown as Pick<${B}, "revoke">`,
    `} as\n  unknown as\n  ${B};`,
    `credentials: {} as ${C},`,
    `x as unknown as HostAccess${"Broker"}`,
  ];
  for (const text of casts)
    expect([text, matches(CAST_TO_SEAM, text)]).toEqual([text, true]);
  const notCasts = [
    `const broker: ${B} = {`,
    `} satisfies ${B};`,
    `import type { ${B} } from "../src/plugins/broker";`,
    `x as ${"Broker"}edProbe`,
    `x as ${"Broker"}App`,
    `alias as const`,
    `has ${B}`,
  ];
  for (const text of notCasts)
    expect([text, matches(CAST_TO_SEAM, text)]).toEqual([text, false]);
});

test("an erased broker is matched; an erased unrelated value is not", () => {
  const erased = [
    `args[29] = { ${BK}, provider: "arcade" } as never;`,
    `listApps ? ({ ${BK}: { listApps } } as never) : undefined,`,
    `const composio${"Broker"} = { tag: "x" } as never;`,
    `const deps = { ${BK}: stub } as any;`,
  ];
  for (const text of erased)
    expect([text, matches(ERASED_BROKER, text)]).toEqual([text, true]);
  const notErased = [
    `(brokerReturnUrl as any)("   "),`,
    `new (${"Broker"}UnconfiguredError as any)()`,
    `credentials: {} as never,`,
    `${BK},\n  credentials: {} as never,`,
    `const ${BK} = make(); const y = z as never;`,
  ];
  for (const text of notErased)
    expect([text, matches(ERASED_BROKER, text)]).toEqual([text, false]);
});

test("a silent revokeAccount is matched; one that records or throws is not", () => {
  const silent = [
    `  ${RA}: async () => {},`,
    `  ${RA}: async (_id) => {},`,
    `  ${RA}: async (id: string) => {\n  },`,
    `  ${RA}: async () => undefined,`,
    `  ${RA}: () => Promise.resolve(),`,
    `  async ${RA}() {},`,
    `  ${RA}(_id: string) {}`,
  ];
  for (const text of silent)
    expect([text, matches(NOOP_REVOKE_ACCOUNT, text)]).toEqual([text, true]);
  const honest = [
    `  ${RA}: async (id) => {\n    asks.push(id);\n  },`,
    `  ${RA}: unasked("revoke one account"),`,
    `  ${RA}: async () => {\n    throw new Error("no");\n  },`,
    `  await ${BK}.${RA}("ca_1");`,
  ];
  for (const text of honest)
    expect([text, matches(NOOP_REVOKE_ACCOUNT, text)]).toEqual([text, false]);
});
