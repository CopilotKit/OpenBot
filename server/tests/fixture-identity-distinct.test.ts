// server/tests/fixture-identity-distinct.test.ts
/**
 * Guard: an account fixture's LOCAL id and its VENDOR id are not the same value.
 *
 * WHY THIS EXISTS. An account ref carries two ids for two different people-in-two-systems:
 * `userId` is who the person is HERE, `vendorUserId` is who the broker knows them as. A broker that
 * asks the vendor under `userId` is asking about somebody else. Round 2's A8a found every one of the
 * 79 person fixtures in `composio-adapter.test.ts` spelling both as `"user_1"` — so no test could
 * tell the two apart, and five planted wrong-identity defects (`revoke`, `isConnected`,
 * `accountName`, `authorize`, `connectWithFields` each asking under `account.userId`) passed 245 of
 * 245 tests. A8a separated the ids and the same plants now redden 1 to 18 tests each. Nothing
 * stopped the collapse coming back; this does.
 *
 * WHAT IT SEES. Every object literal, in every `.ts`/`.tsx` file under the scanned roots, that
 * names BOTH fields of a pair in {@link PAIRS}. The two values are compared after resolving
 * same-file `const` bindings, so `vendorUserId: VENDOR_USER` with `const VENDOR_USER = "user_1"`
 * beside `userId: "user_1"` IS a collapse — that is A8a's exact shape, and a purely textual compare
 * would miss it. Shorthand (`{ userId, vendorUserId: userId }`) is read as the name it binds.
 *
 * WHAT IT DOES NOT SEE — the stated boundary, so nobody reads this as wider than it is:
 *   - a value imported from another file is compared by NAME, not resolved;
 *   - a `let`, a parameter, or a name bound more than once in the file is compared by name, not
 *     value (two different parameters that receive the same string at runtime are invisible);
 *   - an object built by spread (`{ ...base, vendorUserId: x }`) or by assignment after the fact —
 *     only literals naming both fields are read;
 *   - raw SQL (`INSERT … (user_id, vendor_user_id) VALUES …`) — strings are not parsed;
 *   - production code: `server/src` is not scanned. See the note on `accountRefFor` below.
 *
 * NOT EVERY COLLAPSE IS A DEFECT, WHICH IS WHY THIS IS A RATCHET AND NOT A BAN. Production's
 * `accountRefFor` (`server/src/plugins/store.ts`) answers a Personal app with
 * `{ holder: "person", userId: actorId, vendorUserId: actorId }` — for a person, the vendor identity
 * IS the local id today. A store-level test that seeds a `brokered_connections` row or expects that
 * ref is right to collapse the two: it mirrors what production writes. A test that hands an account
 * STRAIGHT TO A BROKER is not — the broker's whole job there is to pick the right field, and a
 * collapsed fixture makes that choice untestable. The scan cannot tell those apart, so every
 * collapse standing today is recorded in {@link KNOWN_COLLAPSES}, keyed by path + quoted expression
 * with a count (never `path:line` — the line-keyed ALLOW list in `assertion-shape.test.ts` collided
 * three waves running; `sole-definition.test.ts`'s path-keyed list never has). Equality both ways:
 *
 *   - MORE fails: a new collapse anywhere — including any file with no entry at all, which is
 *     every broker-adapter suite today. Separate the ids; if the new site truly mirrors
 *     `accountRefFor`'s person ref, raise that entry's count and say so in the commit.
 *   - FEWER fails: a collapse was separated, so the list is stale. Lower or delete the entry.
 *
 * A SECOND RULE, ACROSS FIXTURES. Within one file, no literal id may be a local id in one fixture
 * and a vendor id in another. Two crossed fixtures are as blind as one collapsed one: a broker that
 * asks under the wrong field finds the other fixture's account and the test passes.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { sourceFiles } from "./support/source-scan";

const REPO = join(import.meta.dir, "../..");

/** Where fixtures live. Production is deliberately absent — see the module comment. */
const ROOTS = ["server/tests", "app/tests"];

/** One row per pair of fields that name the same person in two systems. Add pairs as rows. */
const PAIRS: readonly { local: string; vendor: string }[] = [
  { local: "userId", vendor: "vendorUserId" },
  { local: "user_id", vendor: "vendor_user_id" },
];

/**
 * Collapses standing at `f4f6974b`, by file, as `"<local expr> | <vendor expr>": count`.
 *
 * RECORDED, NOT BLESSED. These are of three kinds, and only the first two are harmless:
 *
 *   - ROWS seeded the way production writes them (`brokered_connections`, `pending_authorizations`
 *     for a person, vendor id = actor id), and refs a fake `accountRefFor` answers in that shape.
 *   - EXPECTATIONS of what a route handed a broker spy, after the real `accountRefFor` collapsed
 *     the two — right for as long as production does.
 *   - REFS FED STRAIGHT TO A STORE METHOD OR A BROKER — the A8a shape one layer up. The store reads
 *     `account.vendorUserId` to find rows, and with both ids equal nothing in these files can tell
 *     if it read `userId` instead. Known: `composio-connections.test.ts` (`askerId` into
 *     `connectBrokeredWithFields`, `recheckBrokeredConnection`, `confirmBrokeredConnection`,
 *     `disconnectBrokered`, `probeBrokeredConnection`), `composio-connection-kinds.test.ts`
 *     (`PERSON_ACCOUNT`), `arcade-disconnect-cascade.test.ts` (`disconnectBrokered`),
 *     `arcade-siblings.test.ts` (`siblingApps`), `store-vendor-vocabulary.test.ts`
 *     (`recheckBrokeredConnection`), and `composio-broker-seam.test.ts` /
 *     `test-network-guard.test.ts` (`broker.authorize`, whose subject there is transport, not
 *     identity). Separating these is fix-cycle work; when one is separated this list goes red
 *     until its entry is lowered, which is the point.
 *
 * Every broker-adapter suite (`composio-adapter`, `arcade-adapter*`, `arcade-*-engine`,
 * `composio-grants-for`, …) has NO entry, so its allowance is zero.
 */
const KNOWN_COLLAPSES: Record<string, Record<string, number>> = {
  "server/tests/account-mode.integration.test.ts": {
    "`p1-${suite}` | `p1-${suite}`": 1,
    "`p2-${suite}` | `p2-${suite}`": 1,
  },
  "server/tests/arcade-authorize-route.test.ts": {
    "actor | actor": 1,
  },
  "server/tests/arcade-disconnect-cascade.test.ts": {
    "userId | userId": 2,
  },
  "server/tests/arcade-grants-route.test.ts": {
    "n.viewer | n.viewer": 2,
  },
  "server/tests/arcade-journey.integration.test.ts": {
    "ADMIN | ADMIN": 2,
  },
  "server/tests/arcade-siblings.test.ts": {
    "mine | mine": 1,
    "userId | userId": 5,
  },
  "server/tests/arcade-verify.test.ts": {
    "ACTOR | ACTOR": 6,
    "vendorUserId | vendorUserId": 1,
  },
  "server/tests/composio-broker-seam.test.ts": {
    '"u" | "u"': 1,
  },
  // The row Connect records for a person's held account, expected as the store writes it.
  "server/tests/composio-connect-adopts-held-account.test.ts": {
    "PERSON | PERSON": 1,
  },
  "server/tests/composio-connection-kinds.test.ts": {
    "person | person": 14,
  },
  "server/tests/composio-connections.test.ts": {
    '"" | ""': 3,
    "askerId | askerId": 59,
    "leaverId | leaverId": 4,
  },
  "server/tests/memory-defaults.integration.test.ts": {
    "owner | owner": 1,
  },
  "server/tests/plugin-routes.test.ts": {
    "ADMIN.id | ADMIN.id": 1,
    "DEV_ACTOR.id | DEV_ACTOR.id": 1,
    "actorId | actorId": 1,
  },
  "server/tests/plugin-store.integration.test.ts": {
    '"" | ""': 2,
    '"user-a" | "user-a"': 1,
    '"user-b" | "user-b"': 1,
    '"user_asker" | "user_asker"': 2,
    '"user_leaver" | "user_leaver"': 4,
    "userId | userId": 14,
  },
  "server/tests/remove-server-foreign-provenance.test.ts": {
    "userId | userId": 1,
  },
  "server/tests/routes-arcade-urls.test.ts": {
    '"admin-1" | "admin-1"': 1,
    "actorId | actorId": 1,
  },
  "server/tests/routes-vendor-vocabulary.test.ts": {
    "actorId | actorId": 1,
  },
  "server/tests/shared-brokered-schema.integration.test.ts": {
    "`a-${suite}` | `a-${suite}`": 2,
    "`b-${suite}` | `b-${suite}`": 1,
  },
  "server/tests/shared-brokered-store.integration.test.ts": {
    "asker | asker": 2,
  },
  "server/tests/store-scheme-sites.test.ts": {
    "userId | userId": 1,
  },
  "server/tests/store-vendor-vocabulary.test.ts": {
    '"person-1" | "person-1"': 2,
  },
  "server/tests/test-network-guard.test.ts": {
    '"u" | "u"': 1,
  },
  "server/tests/vendor-deadline-sync-throw.test.ts": {
    "actorId | actorId": 1,
  },
};

/** A literal that was a local id in one fixture and a vendor id in another, by file. */
const KNOWN_CROSSINGS: Record<string, string[]> = {};

type Site = {
  path: string;
  local: string;
  vendor: string;
  localValue: string;
  vendorValue: string;
};

/** Every `const NAME = <expr>` in the file whose NAME is bound exactly once there. */
function constBindings(source: ts.SourceFile): Map<string, ts.Expression> {
  const seen = new Map<string, number>();
  const init = new Map<string, ts.Expression>();
  const bind = (name: ts.BindingName) => {
    if (ts.isIdentifier(name))
      seen.set(name.text, (seen.get(name.text) ?? 0) + 1);
    else
      for (const el of name.elements)
        if (!ts.isOmittedExpression(el)) bind(el.name);
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) {
      bind(node.name);
      const isConst =
        ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.Const) !== 0;
      if (isConst && ts.isIdentifier(node.name) && node.initializer) {
        init.set(node.name.text, node.initializer);
      }
    } else if (ts.isParameter(node)) bind(node.name);
    else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) {
      bind(node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const [name, count] of seen) if (count > 1) init.delete(name);
  return init;
}

/** The value an expression stands for, as far as one file can say: a quoted string, or its text. */
function resolve(
  expr: ts.Expression,
  source: ts.SourceFile,
  consts: Map<string, ts.Expression>,
  depth = 0,
): string {
  if (depth > 8) return expr.getText(source);
  if (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    return resolve(expr.expression, source, consts, depth + 1);
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return JSON.stringify(expr.text);
  }
  if (ts.isIdentifier(expr)) {
    const bound = consts.get(expr.text);
    return bound ? resolve(bound, source, consts, depth + 1) : expr.text;
  }
  if (ts.isTemplateExpression(expr)) {
    const parts = [expr.head.text];
    for (const span of expr.templateSpans) {
      parts.push(`\${${resolve(span.expression, source, consts, depth + 1)}}`);
      parts.push(span.literal.text);
    }
    return `\`${parts.join("")}\``;
  }
  return expr.getText(source).replace(/\s+/g, " ");
}

/** Every object literal in `text` that names both fields of a pair, with both values resolved. */
function pairSites(path: string, text: string): Site[] {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const consts = constBindings(source);
  const out: Site[] = [];
  const field = (node: ts.ObjectLiteralExpression, key: string) =>
    node.properties.find(
      (p) =>
        p.name !== undefined &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
        p.name.text === key,
    );
  const readField = (
    p: ts.ObjectLiteralElementLike,
  ): [string, string] | undefined => {
    if (ts.isPropertyAssignment(p)) {
      return [
        p.initializer.getText(source).replace(/\s+/g, " "),
        resolve(p.initializer, source, consts),
      ];
    }
    if (ts.isShorthandPropertyAssignment(p)) {
      return [p.name.text, resolve(p.name, source, consts)];
    }
    return undefined;
  };
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const { local, vendor } of PAIRS) {
        const l = field(node, local);
        const v = field(node, vendor);
        const lv = l && readField(l);
        const vv = v && readField(v);
        if (lv && vv) {
          out.push({
            path,
            local: lv[0],
            vendor: vv[0],
            localValue: lv[1],
            vendorValue: vv[1],
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function scan(): Site[] {
  const out: Site[] = [];
  for (const root of ROOTS) {
    const full = join(REPO, root);
    if (!existsSync(full)) continue;
    for (const file of sourceFiles(full, [".ts", ".tsx"])) {
      out.push(
        ...pairSites(file.slice(REPO.length + 1), readFileSync(file, "utf8")),
      );
    }
  }
  return out;
}

const isCollapse = (s: Site) => s.localValue === s.vendorValue;
const isLiteral = (v: string) => v.startsWith('"');

/** Collapses by file, as `"<local expr> | <vendor expr>": count`. */
function collapsesOf(sites: Site[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const s of sites.filter(isCollapse)) {
    const byExpr = out[s.path] ?? {};
    out[s.path] = byExpr;
    const key = `${s.local} | ${s.vendor}`;
    byExpr[key] = (byExpr[key] ?? 0) + 1;
  }
  return out;
}

/** Literal ids used as a local id in one distinct fixture and a vendor id in another, by file. */
function crossingsOf(sites: Site[]): Record<string, string[]> {
  const byFile = new Map<
    string,
    { locals: Set<string>; vendors: Set<string> }
  >();
  for (const s of sites) {
    if (isCollapse(s)) continue;
    const f = byFile.get(s.path) ?? { locals: new Set(), vendors: new Set() };
    byFile.set(s.path, f);
    if (isLiteral(s.localValue)) f.locals.add(s.localValue);
    if (isLiteral(s.vendorValue)) f.vendors.add(s.vendorValue);
  }
  const out: Record<string, string[]> = {};
  for (const [path, { locals, vendors }] of byFile) {
    const both = [...locals].filter((v) => vendors.has(v)).sort();
    if (both.length > 0) out[path] = both;
  }
  return out;
}

const sites = scan();

test("the scan reaches the fixtures it claims to cover", () => {
  // An enumerator that silently stopped seeing files would turn every rule below green.
  // A8a's suite alone holds 79 person fixtures naming both ids.
  const adapter = sites.filter(
    (s) => s.path === "server/tests/composio-adapter.test.ts",
  );
  expect(adapter.length).toBeGreaterThanOrEqual(79);
  expect(new Set(sites.map((s) => s.path)).size).toBeGreaterThanOrEqual(40);
});

test("no account fixture names its local id and its vendor id as the same value, beyond the record", () => {
  expect(collapsesOf(sites)).toEqual(KNOWN_COLLAPSES);
});

test("no literal id is a local id in one fixture and a vendor id in another, beyond the record", () => {
  expect(crossingsOf(sites)).toEqual(KNOWN_CROSSINGS);
});

test("positive control: A8a's collapse, spelled through a const, is seen", () => {
  const collapsed = pairSites(
    "x.test.ts",
    `const VENDOR_USER = "user_1";
     broker.revoke({ account: { holder: "person", userId: "user_1", vendorUserId: VENDOR_USER } });`,
  );
  expect(collapsesOf(collapsed)).toEqual({
    "x.test.ts": { '"user_1" | VENDOR_USER': 1 },
  });
  const separated = pairSites(
    "x.test.ts",
    `const VENDOR_USER = "composio_user_1";
     broker.revoke({ account: { holder: "person", userId: "user_1", vendorUserId: VENDOR_USER } });`,
  );
  expect(collapsesOf(separated)).toEqual({});
});

test("positive control: shorthand, snake_case, and crossed fixtures are seen", () => {
  const sitesOf = pairSites(
    "y.test.ts",
    `function hold(vendorUserId: string) { return { userId: vendorUserId, vendorUserId }; }
     const row = { user_id: \`u-\${suite}\`, vendor_user_id: \`u-\${suite}\` };
     const a = { userId: "alice", vendorUserId: "v_alice" };
     const b = { userId: "v_alice", vendorUserId: "v_bob" };`,
  );
  expect(collapsesOf(sitesOf)).toEqual({
    "y.test.ts": {
      "vendorUserId | vendorUserId": 1,
      "`u-${suite}` | `u-${suite}`": 1,
    },
  });
  expect(crossingsOf(sitesOf)).toEqual({ "y.test.ts": ['"v_alice"'] });
});

test("negative control: a name bound twice is not resolved through either binding", () => {
  // Two `const id` in different scopes: resolving either would invent a collapse or hide one.
  const sitesOf = pairSites(
    "z.test.ts",
    `{ const id = "a"; } { const id = "b"; }
     const ref = { userId: "a", vendorUserId: id };`,
  );
  expect(collapsesOf(sitesOf)).toEqual({});
});
