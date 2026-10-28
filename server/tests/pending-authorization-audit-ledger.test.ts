// server/tests/pending-authorization-audit-ledger.test.ts
/**
 * Guard: every write to `pending_authorizations` has a RECORDED AUDIT DECISION. It names the event
 * it files, or it is recorded as debt, or it carries a waiver that argues why no event fits.
 *
 * WHY THIS EXISTS. This PR's subject is attributable consent: a mint/claim/complete lifecycle whose
 * return leg is bound to the attempt the signed-in person actually minted. Round 2 wave 3 (B5e)
 * counted the transitions that lifecycle can make and found that one in nine filed an audit row.
 * Nothing had ever forced the question "which event?" when a write was added, so the question was
 * never asked. This ledger asks it. A new write site with no entry below fails, and so does an
 * entry whose site is gone. Adding an unaudited transition is now something somebody does on
 * purpose and writes down.
 *
 * THREE DISPOSITIONS, AND TWO OF THEM MUST NOT BE CONFUSED.
 *
 *   - `audited`: names an event in `auditEventTypes` and the function that files it. The guard
 *     checks that the named function contains that event literal. When the filer is not the writer
 *     itself, it also checks that a call to the filer sits next to the write.
 *   - `debt`: this transition SHOULD be audited and is not. That is a finding, and it carries the
 *     finding id. It follows the `typecheck-baseline.txt` discipline: converting a debt row into
 *     `audited` and deleting the debt is always correct. Adding one is not. {@link DEBT_CEILING}
 *     pins the count so a new debt row has to be argued for in the same diff that adds it.
 *   - `waived`: NO audit event is appropriate here. That is a judgement, and the reason is written
 *     down. "It is not audited today" is never a waiver. That is debt.
 *
 * HOW IT IS KEYED, AND WHY NOT `path:line`. `assertion-shape.test.ts` is keyed by line and collided
 * in three consecutive waves. Here:
 *
 *   - A write STATEMENT is keyed by its enclosing function's name plus the quoted write
 *     expression. A migration is keyed by its file name instead.
 *   - A CALL SITE of a writing method is keyed by file + method + ordinal (source order). An anchor
 *     string confirms that each ordinal is still the transition the ledger says it is. The nearest
 *     same-method call to the anchor must be this one.
 *   - A CASCADE is keyed by its constraint name.
 *
 * Moving code around, rewrapping a comment or adding a line above changes none of these keys.
 *
 * WHAT GREEN MEANS, AND WHAT IT DOES NOT. Read this before trusting it.
 *
 *   1. IT CHECKS THE DECLARATION, NOT THE FIRING. For `audited` rows it checks that the event exists,
 *      that the named filer files it, and that the filer is called beside the write. It does not
 *      prove the event fires on every path through that write, or that the payload is clean (no
 *      bearer consent url, no live `auth_id`). The behavioural plants for that are in
 *      `arcade-authorize-cancel.test.ts` (B5b) and the completion tests.
 *   2. IT CANNOT SEE A TRANSITION THAT WRITES NOTHING. B2c is the example: a cancel that LOST the
 *      race to a completion deletes no row, so no scan of write sites can find it. Such non-writes
 *      are listed BY HAND in {@link NON_WRITES}. The guard only checks that each listed one still
 *      exists where it says, so the list cannot go stale silently. It DISCOVERS NOTHING. A new
 *      silent branch that writes nothing stays invisible here.
 *   3. IT SEES WRITES SPELLED THROUGH THE DRIZZLE SYMBOL OR THE LITERAL TABLE NAME. A table name
 *      assembled at runtime (`sql.raw`, string concatenation) or a writer method passed by
 *      reference is outside it. An aliased import of the table symbol, and a writer method named
 *      without being called, are both refused outright rather than missed.
 *   4. CASCADES ARE READ FROM `server/drizzle/*.sql`, which is what the database runs. A schema
 *      edit with no migration is a different defect, and this guard does not look for it.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { auditEventTypes } from "../src/audit";
import { sourceFiles, stripComments } from "./support/source-scan";

const REPO = join(import.meta.dir, "../..");

/** TypeScript trees that can hold a write. Tests are excluded by file name below. */
const TS_ROOTS = [
  "server/src",
  "server/scripts",
  "scripts",
  "worker",
  "shared",
];
const MIGRATIONS = "server/drizzle";

type AuditEvent = (typeof auditEventTypes)[number];

type Disposition =
  | { audited: AuditEvent; filedBy: string }
  | { debt: string; note: string }
  | { waived: string };

type Transition = { name: string } & Disposition;

/*
 * ─── THE LEDGER ──────────────────────────────────────────────────────────────────────────────
 */

/**
 * Every statement that writes the table, keyed `<enclosing function or migration file> :: <write
 * expression>`.
 *
 * A row whose transitions depend on who called it says so: `decidedAtCallers`. That is not a pass.
 * It obliges every call of that function to appear in {@link CALL_SITES} with its own disposition,
 * and the guard enforces that.
 */
const STATEMENTS: Record<
  string,
  { decidedAtCallers: true } | { transitions: Transition[] }
> = {
  // The claim INSERT and the ON CONFLICT re-claim of an expired or settled row are one statement.
  // Their dispositions are recorded at the one call site.
  "claimAuthorizationAttempt :: INSERT INTO pending_authorizations": {
    decidedAtCallers: true,
  },
  "recordAuthorizationMint :: .update(pendingAuthorizations)": {
    decidedAtCallers: true,
  },
  // One DELETE behind three different endings: two mint-failure clean-ups and the person's cancel.
  "discardAuthorizationAttempt :: .delete(pendingAuthorizations)": {
    decidedAtCallers: true,
  },
  // The one statement behind failed, unreconciled and withdrawn; see DELEGATIONS.
  "closeAuthorizationAttempt :: .update(pendingAuthorizations)": {
    decidedAtCallers: true,
  },
  "completeAuthorizationAttempt :: UPDATE pending_authorizations": {
    decidedAtCallers: true,
  },
};

/**
 * Store-internal delegation: `from` is called ONLY by the listed wrappers. Every call of a wrapper
 * then needs a {@link CALL_SITES} row. If any other function calls `from`, that call is undeclared
 * and fails.
 */
const DELEGATIONS: Record<string, string[]> = {
  closeAuthorizationAttempt: [
    "failAuthorizationAttempt",
    "markAuthorizationUnreconciled",
    "markAuthorizationWithdrawn",
  ],
};

/**
 * Every call of a writing method, keyed `<file> :: <method>`, IN SOURCE ORDER. Each entry has an
 * `anchor`: a string near the call that names the branch. The call nearest the anchor must be that
 * ordinal, so two calls cannot swap transitions without the guard noticing.
 */
const CALL_SITES: Record<
  string,
  { anchor: string; transitions: Transition[] }[]
> = {
  "server/src/plugins/route-groups/connections.ts :: claimAuthorizationAttempt":
    [
      {
        anchor: "if (!claim.claimed)",
        transitions: [
          {
            name: "claim (a person starts an authorization)",
            debt: "B5e",
            note: "The moment a signed-in person starts a consent leaves no row on the trail, so nothing records who started which attempt.",
          },
          {
            name: "expiry overwrite (re-claim silently replaces an expired or settled attempt)",
            debt: "B5e",
            note: "An attempt that expired while still live is never recorded as having ended. The next claim's ON CONFLICT DO UPDATE erases it.",
          },
        ],
      },
    ],
  "server/src/plugins/route-groups/connections.ts :: discardAuthorizationAttempt":
    [
      {
        anchor: "arcade-refused-attempt-not-cleared",
        transitions: [
          {
            name: "discard after the vendor refused the mint",
            debt: "B5e",
            note: "A started attempt ends with only a console line on cleanup failure. A refusal on a consent lifecycle should be on the trail, as `mcp.callback_refused` and `session.refused` are elsewhere.",
          },
        ],
      },
      {
        anchor: "arcade-mint-not-recorded",
        transitions: [
          {
            name: "discard after the mint succeeded but could not be recorded",
            debt: "B5e",
            note: "A flow is LIVE at the vendor and the only record is the `arcade-mint-not-recorded` console line. This is the strongest case for an event in the ledger.",
          },
        ],
      },
      {
        anchor: "const cancelled = await store.discardAuthorizationAttempt",
        transitions: [
          {
            name: "withdrawn by the person (cancel)",
            audited: "mcp.authorization_cancelled",
            filedBy: "recordAuthorizationCancelled",
          },
        ],
      },
    ],
  "server/src/plugins/route-groups/connections.ts :: recordAuthorizationMint": [
    {
      anchor: "authId: minted.authorizationId",
      transitions: [
        {
          name: "mint recorded (attempt bound to the vendor's authorization)",
          debt: "B5e",
          note: "The binding the return leg is checked against is written without a trail row. The `false` this call can answer is its own hand-listed transition in NON_WRITES.",
        },
      ],
    },
  ],
  "server/src/plugins/route-groups/connections.ts :: failAuthorizationAttempt":
    [
      {
        anchor: 'settled.status === "failed"',
        transitions: [
          {
            name: "failed (the vendor reported the consent failed)",
            debt: "B5e",
            note: "A terminal verdict on the attempt with no trail row.",
          },
        ],
      },
      {
        anchor: "settled.userId !== attempt.vendorUserId",
        transitions: [
          {
            name: "failed (the consent completed for an identity that is not the attempt's)",
            debt: "B5e",
            note: "A return leg that came back bound to somebody else is the exact attribution failure this lifecycle exists to refuse, and the refusal leaves no row.",
          },
        ],
      },
    ],
  "server/src/plugins/route-groups/connections.ts :: markAuthorizationWithdrawn":
    [
      {
        anchor: "if (withdrawn)",
        transitions: [
          {
            name: "withdrawn (context changed; the vendor withdrew the retired grant)",
            debt: "B5e",
            note: "Only indirectly audited. `clearWithdrawnAccount` files `mcp.account_disconnected` rows for what it cleared, but the verdict on the attempt itself is not filed.",
          },
        ],
      },
    ],
  "server/src/plugins/route-groups/connections.ts :: markAuthorizationUnreconciled":
    [
      {
        anchor: "arcade-completion-not-permitted",
        transitions: [
          {
            name: "unreconciled (the person may no longer act on the app's account; nothing withdrawn)",
            debt: "B5e",
            note: "A consent live at the vendor that this deployment closed without recording or withdrawing — most often an administrator demoted mid-consent on a Shared app. The only record is a console line.",
          },
        ],
      },
      {
        anchor: "else await store.markAuthorizationUnreconciled",
        transitions: [
          {
            name: "unreconciled (context changed; withdrawing the retired grant was not confirmed)",
            debt: "B5e",
            note: "The case where a grant may still be live at the vendor, and the only record is a console line.",
          },
        ],
      },
    ],
  "server/src/plugins/route-groups/connections.ts :: completeAuthorizationAttempt":
    [
      {
        anchor: "recorded = claimed",
        transitions: [
          {
            name: "completed",
            audited: "mcp.account_connected",
            filedBy: "completeAuthorizationAttempt",
          },
        ],
      },
    ],
};

/** Every foreign key that deletes rows of this table when its parent goes, keyed by constraint. */
const CASCADES: Record<string, Transition> = {
  pending_authorizations_server_id_mcp_servers_id_fk: {
    name: "cascade delete when the app's server row is removed",
    debt: "B5e",
    note: "`removeServer` files `configuration.changed` (`mcp_server_removed`) and names the grants it released. It does not name an in-flight attempt, which may already be consented at the vendor.",
  },
  pending_authorizations_actor_id_users_id_fk: {
    name: "cascade delete when the attempt's actor is deleted",
    debt: "B5e",
    note: "`retireConnectionsFor` files rows for the connections it retires. An attempt that dies with its actor, possibly minted and live at the vendor, is not among them.",
  },
  // `pending_authorizations_user_id_users_id_fk` was a third row here (debt B5e) until an earlier
  // draft of this table's migration dropped it: with nothing making `user_id` equal `actor_id`, it let one person's deletion take an
  // attempt a DIFFERENT person had started. `pending_authorizations_user_is_actor_check` now holds
  // the equality and the actor key above is the only cascade from `users`. Removed with the key,
  // and DEBT_CEILING lowered with it — not relabelled.
};

/**
 * Transitions that WRITE NOTHING and so cannot be found by a scan. They are listed by hand, and
 * each is checked only for still existing at its anchor. See boundary 2 in the file header.
 */
const NON_WRITES: Record<
  string,
  { file: string; anchor: string } & Transition
> = {
  "cancel that lost the race to a completion": {
    file: "server/src/plugins/route-groups/connections.ts",
    anchor: "That authorization finished before it could be cancelled",
    name: "cancel refused because the attempt had already completed",
    debt: "B2c",
    note: "The person asked to retract consent and the consent stood. The 409 tells them, and the trail records nothing about the request. The discard deleted nothing, so no write site exists for this guard to find.",
  },
  "completion that found its attempt already cancelled": {
    file: "server/src/plugins/route-groups/connections.ts",
    anchor: 'return refusedWith("cancelled")',
    name: "completion claimed nothing because the attempt was cancelled during the return leg",
    waived:
      "This branch ends no attempt: the cancel's deletion already ended it and filed `mcp.authorization_cancelled`, so a second row would record the same withdrawal twice. What the branch adds is a vendor-side withdrawal of the grant the return carried, or, where that would end more than the cancelled consent, an `arcade-cancelled-grant-left-live` line and an `mcp.cancelled_grant_left_live` row — which records the grant left live, not the attempt's ending.",
  },
  "mint that found its attempt already cancelled": {
    file: "server/src/plugins/route-groups/connections.ts",
    anchor: "That authorization was cancelled before it started",
    name: "mint declined because the attempt was cancelled while the vendor was minting (B5d)",
    waived:
      "This branch ends no attempt: the attempt it would describe was already ended by the person's cancel, and that cancel filed `mcp.authorization_cancelled` for it. A second row would record the same withdrawal twice. What the branch adds is a refusal to hand out the consent url, and that url, like the `ar_...`, must never reach the trail.",
  },
};

/**
 * The most debt rows the ledger may hold: transitions plus cascades plus non-writes. This may only
 * go DOWN. A fix that converts a row lowers it in the same diff. A new debt row has to raise it,
 * and that edit is the record that somebody decided to add one.
 */
const DEBT_CEILING = 13;

/*
 * ─── THE SCAN ────────────────────────────────────────────────────────────────────────────────
 */

/** A named function, method or `const x = async` binding, i.e. what "enclosing function" means. */
const DEFINITION =
  /(?:\basync\s+(?:function\s*\*?\s*)?([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\b|function\b)|\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\()/g;

type Definition = { name: string; at: number };

function definitionsIn(code: string): Definition[] {
  const out: Definition[] = [];
  for (const m of code.matchAll(DEFINITION)) {
    const name = m[1] ?? m[2] ?? m[3];
    if (name && name !== "function") out.push({ name, at: m.index ?? 0 });
  }
  return out;
}

function enclosing(defs: Definition[], at: number): string {
  let name = "<module>";
  for (const def of defs) {
    if (def.at > at) break;
    name = def.name;
  }
  return name;
}

/** From a definition's header to the next definition: the text the function's body lives in. */
function spanOf(code: string, defs: Definition[], name: string): string {
  const index = defs.findIndex((def) => def.name === name);
  if (index === -1) return "";
  return code.slice(defs[index].at, defs[index + 1]?.at ?? code.length);
}

function lineAt(code: string, at: number): number {
  return code.slice(0, at).split("\n").length;
}

/** Not a test, not a declaration file. */
function isSource(path: string): boolean {
  return !/\.(test|spec)\.tsx?$|\.d\.ts$/.test(path);
}

type Scanned = { path: string; code: string; defs: Definition[] };

function scanTs(): Scanned[] {
  const out: Scanned[] = [];
  for (const root of TS_ROOTS) {
    const full = join(REPO, root);
    if (!existsSync(full)) continue;
    for (const file of sourceFiles(full, [".ts", ".tsx"])) {
      if (!isSource(file) || file.includes("/node_modules/")) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      out.push({
        path: file.slice(REPO.length + 1),
        code,
        defs: definitionsIn(code),
      });
    }
  }
  return out;
}

/** The SQL of every migration with `--` line comments blanked, per file. */
function scanSql(): { file: string; sql: string }[] {
  return sourceFiles(join(REPO, MIGRATIONS), [".sql"]).map((file) => ({
    file: basename(file),
    sql: readFileSync(file, "utf8").replace(/--(?!>)[^\n]*/g, ""),
  }));
}

/** A write through the drizzle symbol, a raw statement or an interpolated symbol. */
const TS_WRITE =
  /\.\s*(insert|update|delete)\s*\(\s*pendingAuthorizations\s*\)|\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:"?pending_authorizations"?|\$\{\s*pendingAuthorizations\s*\})(?![\w])/gi;

const SQL_WRITE =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+("?pending_authorizations"?)(?![\w])/gi;

/** How an interpolated table symbol is spelled in a key: the `${…}` of a `sql` template. */
const INTERPOLATED = `$${"{"}pendingAuthorizations}`;

/** The ledger key of one TypeScript write: the enclosing function and the write, normalized. */
function tsWriteKey(defs: Definition[], match: RegExpMatchArray): string {
  const expression = match[1]
    ? `.${match[1].toLowerCase()}(pendingAuthorizations)`
    : `${match[2].toUpperCase().replace(/\s+/g, " ")} ${
        match[0].includes(INTERPOLATED.slice(0, 2))
          ? INTERPOLATED
          : "pending_authorizations"
      }`;
  return `${enclosing(defs, match.index ?? 0)} :: ${expression}`;
}

function findWriteStatements(
  files: Scanned[],
  migrations: { file: string; sql: string }[],
): string[] {
  const out: string[] = [];
  for (const { code, defs } of files) {
    for (const match of code.matchAll(TS_WRITE))
      out.push(tsWriteKey(defs, match));
  }
  for (const { file, sql } of migrations) {
    for (const match of sql.matchAll(SQL_WRITE)) {
      // CREATE TABLE and ALTER TABLE are DDL; only DML is a transition.
      out.push(
        `${file} :: ${match[1].toUpperCase().replace(/\s+/g, " ")} ${match[2]}`,
      );
    }
  }
  return out.sort();
}

/** Every `ON DELETE` other than `restrict`/`no action` on a foreign key OF this table. */
function findCascades(migrations: { file: string; sql: string }[]): string[] {
  const live = new Set<string>();
  for (const { sql } of migrations) {
    for (const stmt of sql.split(/;|-->\s*statement-breakpoint/)) {
      const add =
        /ALTER\s+TABLE\s+"?pending_authorizations"?\s+ADD\s+CONSTRAINT\s+"([^"]+)"\s+FOREIGN\s+KEY[\s\S]*ON\s+DELETE\s+(cascade|set\s+null|set\s+default)/i.exec(
          stmt,
        );
      if (add) live.add(add[1]);
      const drop =
        /ALTER\s+TABLE\s+"?pending_authorizations"?\s+DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/i.exec(
          stmt,
        );
      if (drop) live.delete(drop[1]);
      // A foreign key declared inline in CREATE TABLE.
      if (/CREATE\s+TABLE\s+"?pending_authorizations"?/i.test(stmt)) {
        for (const inline of stmt.matchAll(
          /CONSTRAINT\s+"([^"]+)"\s+FOREIGN\s+KEY[^,]*ON\s+DELETE\s+(?:cascade|set\s+null|set\s+default)/gi,
        )) {
          live.add(inline[1]);
        }
      }
    }
  }
  return [...live].sort();
}

/** Writer method names whose calls are transitions: statement sites decided at callers, plus wrappers. */
function writerMethods(): string[] {
  const names = new Set<string>();
  for (const [key, entry] of Object.entries(STATEMENTS)) {
    if ("decidedAtCallers" in entry) names.add(key.split(" :: ")[0]);
  }
  for (const [from, via] of Object.entries(DELEGATIONS)) {
    names.delete(from);
    for (const wrapper of via) names.add(wrapper);
  }
  return [...names].sort();
}

type Call = { path: string; method: string; line: number; enclosing: string };

/**
 * Every call of `names`, and every non-call mention of them (a method passed by reference is
 * a write the ledger cannot follow, so it is reported rather than missed).
 */
function findCalls(
  files: Scanned[],
  names: string[],
): { calls: Call[]; references: string[] } {
  const calls: Call[] = [];
  const references: string[] = [];
  for (const { path, code, defs } of files) {
    for (const method of names) {
      for (const m of code.matchAll(
        new RegExp(`(?<![\\w$])${method}(?![\\w$])`, "g"),
      )) {
        const at = m.index ?? 0;
        const before = code.slice(Math.max(0, at - 40), at);
        const after = code.slice(at + method.length);
        if (/(?:\basync|\bfunction\s*\*?|\b(?:const|let|var))\s+$/.test(before))
          continue; // its own definition
        if (/^\s*\(/.test(after)) {
          calls.push({
            path,
            method,
            line: lineAt(code, at),
            enclosing: enclosing(defs, at),
          });
        } else if (!/^\s*:/.test(after) && !/["'`]$/.test(before)) {
          // Not a call, not a property key or type member, not a string: a reference.
          references.push(`${path}:${lineAt(code, at)} ${method}`);
        }
      }
    }
  }
  return { calls, references };
}

function dispositionsOf(): Transition[] {
  return [
    ...Object.values(STATEMENTS).flatMap((entry) =>
      "transitions" in entry ? entry.transitions : [],
    ),
    ...Object.values(CALL_SITES).flatMap((sites) =>
      sites.flatMap((site) => site.transitions),
    ),
    ...Object.values(CASCADES),
    ...Object.values(NON_WRITES),
  ];
}

/*
 * ─── THE CHECKS ──────────────────────────────────────────────────────────────────────────────
 */

/** How far, in lines, an anchor or a filer call may sit from the write it belongs to. */
const ANCHOR_WINDOW = 20;

const files = scanTs();
const migrations = scanSql();

test("every write statement against pending_authorizations is in the ledger, and every ledger statement still exists", () => {
  expect(findWriteStatements(files, migrations)).toEqual(
    Object.keys(STATEMENTS).sort(),
  );
});

test("the table symbol is never imported under another name, which would hide its writes", () => {
  const aliased = files
    .filter(({ code }) =>
      /\bpendingAuthorizations\s+as\s+[\w$]+|=\s*pendingAuthorizations\s*[;,\n]/.test(
        code,
      ),
    )
    .map(({ path }) => path);
  expect(aliased).toEqual([]);
});

test("every cascade that deletes attempts is in the ledger", () => {
  expect(findCascades(migrations)).toEqual(Object.keys(CASCADES).sort());
});

test("store-internal delegation goes only through the declared wrappers", () => {
  for (const [from, via] of Object.entries(DELEGATIONS)) {
    const { calls } = findCalls(files, [from]);
    expect(calls.map((call) => call.enclosing).sort()).toEqual([...via].sort());
  }
});

test("every call of a writing method has a disposition, in source order, at its anchor", () => {
  const methods = writerMethods();
  const { calls, references } = findCalls(files, methods);
  // A writer passed by reference escapes the call-site count; refuse it rather than miss it.
  expect(references).toEqual([]);

  const grouped = new Map<string, Call[]>();
  for (const call of calls) {
    const key = `${call.path} :: ${call.method}`;
    grouped.set(key, [...(grouped.get(key) ?? []), call]);
  }
  expect([...grouped.keys()].sort()).toEqual(Object.keys(CALL_SITES).sort());

  for (const [key, sites] of Object.entries(CALL_SITES)) {
    const found = (grouped.get(key) ?? []).sort((a, b) => a.line - b.line);
    expect({ key, count: found.length }).toEqual({ key, count: sites.length });
    const [path] = key.split(" :: ");
    const lines = (files.find((file) => file.path === path)?.code ?? "").split(
      "\n",
    );
    sites.forEach((site, ordinal) => {
      expect({
        key,
        ordinal,
        transitions: site.transitions.length > 0,
      }).toEqual({
        key,
        ordinal,
        transitions: true,
      });
      // The call NEAREST to some occurrence of the anchor must be this ordinal.
      const nearestToAnchor = lines.flatMap((text, index) => {
        if (!text.includes(site.anchor)) return [];
        const line = index + 1;
        const nearest = found.reduce(
          (best, call, i) =>
            Math.abs(call.line - line) < Math.abs(found[best].line - line)
              ? i
              : best,
          0,
        );
        return Math.abs(found[nearest].line - line) <= ANCHOR_WINDOW
          ? [nearest]
          : [];
      });
      expect({
        key,
        ordinal,
        anchor: site.anchor,
        at: nearestToAnchor.includes(ordinal),
      }).toEqual({ key, ordinal, anchor: site.anchor, at: true });

      // An audited transition whose filer is not the writer must call the filer beside the write.
      for (const transition of site.transitions) {
        if (!("audited" in transition)) continue;
        if (transition.filedBy === key.split(" :: ")[1]) continue;
        const call = found[ordinal];
        const window = lines
          .slice(Math.max(0, call.line - 1), call.line - 1 + ANCHOR_WINDOW)
          .join("\n");
        expect({
          transition: transition.name,
          filerCalledAfterWrite: new RegExp(
            `(?<![\\w$])${transition.filedBy}\\s*\\(`,
          ).test(window),
        }).toEqual({
          transition: transition.name,
          filerCalledAfterWrite: true,
        });
      }
    });
  }
});

test("every audited transition names a real event, and its filer files exactly that event", () => {
  for (const transition of dispositionsOf()) {
    if (!("audited" in transition)) continue;
    expect(auditEventTypes).toContain(transition.audited);
    const filers = files.filter(({ defs }) =>
      defs.some((def) => def.name === transition.filedBy),
    );
    const filesIt = filers.map(({ code, defs }) =>
      spanOf(code, defs, transition.filedBy).includes(
        `eventType: "${transition.audited}"`,
      ),
    );
    expect({
      transition: transition.name,
      filesIt: filesIt.includes(true),
    }).toEqual({
      transition: transition.name,
      filesIt: true,
    });
  }
});

test("a waiver argues, and a debt names its finding", () => {
  const all = dispositionsOf();
  // A reason, not a label. "unaudited", "todo" and "n/a" are debt pretending to be judgement.
  const thinWaivers = all.flatMap((t) =>
    "waived" in t &&
    (t.waived.length <= 80 ||
      /^(todo|n\/?a|unaudited|none|tbd)\b/i.test(t.waived))
      ? [t.name]
      : [],
  );
  expect(thinWaivers).toEqual([]);
  const unnamedDebts = all.flatMap((t) =>
    "debt" in t && (!/^[A-Z]\d+[a-z]?$/.test(t.debt) || t.note.length <= 20)
      ? [t.name]
      : [],
  );
  expect(unnamedDebts).toEqual([]);
});

test("debt only goes down", () => {
  const debts = dispositionsOf().filter((t) => "debt" in t).length;
  // Equality, not <=: a converted row must lower the ceiling in the same diff, so it cannot
  // quietly make room for a new debt elsewhere.
  expect(debts).toBe(DEBT_CEILING);
});

test("every hand-listed non-write still exists where the ledger says", () => {
  for (const [key, entry] of Object.entries(NON_WRITES)) {
    const code = files.find((file) => file.path === entry.file)?.code ?? "";
    expect({ key, present: code.includes(entry.anchor) }).toEqual({
      key,
      present: true,
    });
  }
});

/*
 * ─── THE SCANNER'S OWN CONTROLS ──────────────────────────────────────────────────────────────
 * The checks above prove the ledger matches the tree. These prove the scanner would SEE a write
 * spelled each way it claims to, so a green above cannot mean "the pattern matches nothing".
 */

test("the scanner sees every spelling of a write it claims to, and no read", () => {
  const plant = (code: string): Scanned => ({
    path: "planted.ts",
    code,
    defs: definitionsIn(code),
  });
  const writes = [
    "async a() { await db.insert(pendingAuthorizations).values({}); }",
    "async b() { await db\n  .update( pendingAuthorizations )\n  .set({}); }",
    "async c() { await tx.delete(pendingAuthorizations); }",
    "async d() { await db.execute(sql`INSERT INTO pending_authorizations (x) VALUES (1)`); }",
    "async e() { await db.execute(sql`update pending_authorizations set x = 1`); }",
    'async f() { await db.execute(sql`DELETE FROM "pending_authorizations" WHERE 1`); }',
    `async g() { await db.execute(sql\`DELETE FROM ${INTERPOLATED} WHERE 1\`); }`,
    "const h = async () => { await db.execute(sql`TRUNCATE pending_authorizations`); };",
  ];
  expect(findWriteStatements(writes.map(plant), [])).toEqual([
    "a :: .insert(pendingAuthorizations)",
    "b :: .update(pendingAuthorizations)",
    "c :: .delete(pendingAuthorizations)",
    "d :: INSERT INTO pending_authorizations",
    "e :: UPDATE pending_authorizations",
    "f :: DELETE FROM pending_authorizations",
    `g :: DELETE FROM ${INTERPOLATED}`,
    "h :: TRUNCATE pending_authorizations",
  ]);
  const reads = [
    "async r() { await db.select().from(pendingAuthorizations); }",
    "async s() { await db.execute(sql`SELECT * FROM pending_authorizations`); }",
    "async t() { await db.update(pendingAuthorizationsArchive).set({}); }",
    "async u() { await db.execute(sql`UPDATE pending_authorizations_log SET x = 1`); }",
  ];
  expect(findWriteStatements(reads.map(plant), [])).toEqual([]);
  expect(
    findWriteStatements(
      [],
      [
        {
          file: "9999_x.sql",
          sql: 'CREATE TABLE "pending_authorizations" (x text);\nDELETE FROM "pending_authorizations" WHERE true;',
        },
      ],
    ),
  ).toEqual(['9999_x.sql :: DELETE FROM "pending_authorizations"']);
});

test("the cascade scan sees an added cascade and forgets a dropped one", () => {
  expect(
    findCascades([
      {
        file: "1.sql",
        sql: 'ALTER TABLE "pending_authorizations" ADD CONSTRAINT "k1" FOREIGN KEY ("a") REFERENCES "public"."x"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint\nALTER TABLE "pending_authorizations" ADD CONSTRAINT "k2" FOREIGN KEY ("b") REFERENCES "public"."y"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint\nALTER TABLE "pending_authorizations" ADD CONSTRAINT "k3" FOREIGN KEY ("c") REFERENCES "public"."z"("id") ON DELETE restrict ON UPDATE no action;',
      },
      {
        file: "2.sql",
        sql: 'ALTER TABLE "pending_authorizations" DROP CONSTRAINT "k1";',
      },
    ]),
  ).toEqual(["k2"]);
});

test("a writer called, passed by reference, or defined are told apart", () => {
  const code = [
    "async discardAuthorizationAttempt(input) {}",
    "await store.discardAuthorizationAttempt({ a: 1 });",
    "await store\n  .discardAuthorizationAttempt({ a: 1 });",
    "promise.then(store.discardAuthorizationAttempt);",
  ].join("\n");
  const { calls, references } = findCalls(
    [{ path: "p.ts", code, defs: definitionsIn(code) }],
    ["discardAuthorizationAttempt"],
  );
  expect(calls.map((call) => call.line)).toEqual([2, 4]);
  expect(references).toEqual(["p.ts:5 discardAuthorizationAttempt"]);
});
