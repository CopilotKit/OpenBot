#!/usr/bin/env bun
// The mutation register: known defects, planted on purpose, that named suites MUST catch.
//
// WHY THIS EXISTS. The defect class this repo's review cycles found most often is not a wrong line;
// it is a suite that cannot tell two things apart that the code must keep apart — a local id and a
// vendor id, a folded and an unfolded status, an absent field and an unreadable one, a scoped query
// and an unscoped one, a call made and a call silently not made. A suite like that stays green when
// the distinction is broken, so nothing fails and nothing changes. Each review wave checked this by
// hand — "five planted identity defects passed 245/245" — and the check was never recorded, so the
// next fake or fixture could re-collapse the distinction without anyone noticing. This file is that
// hand check, written down, so it can be re-run by anyone at any time.
//
// WHAT A RUN DOES, per entry:
//   1. Locates the entry's quoted expression in the target file (see "KEYED BY QUOTED EXPRESSION").
//   2. Runs the entry's test files UNMUTATED, once per distinct file set. They must pass: a mutant
//      "caught" by a suite that was already red proves nothing.
//   3. Runs the same files with the mutation applied IN MEMORY by `mutation-register-preload.ts`,
//      a bun loader plugin that rewrites the module's source as it is imported. The file on disk is
//      never written, so a crash, a timeout or a Ctrl-C cannot leave the tree mutated. The preload
//      leaves a mark when it actually rewrote the module; no mark means the named suites never
//      imported the file, which is the register being wrong, and it fails as such.
//   4. A mutant is KILLED when the run reports at least one `(fail)` test. Only a failing TEST
//      counts — an import error or a crash is not a suite telling the distinction apart.
//
// THE VERDICT, and what each failure means:
//   - an entry with no `survivesUntil` whose mutant SURVIVES → a coverage hole. The named suite
//     cannot see this distinction any more. Fix the suite, not the register.
//   - an entry WITH `survivesUntil` whose mutant is KILLED → the debt is paid. Delete the
//     `survivesUntil` field so the entry starts guarding.
//   - an expression that cannot be located → the guarded code changed. Re-quote it deliberately.
//
// `survivesUntil` IS A RECORD OF DEBT, the same discipline as `server/tests/typecheck-baseline.txt`:
// every entry carrying it is a real defect the suite cannot see today, named by the finding that
// owns it. Removing one because the suite now catches the mutant is always correct. ADDING one to
// an entry that was guarding is not — that is a suite losing coverage, and this check exists to say
// so. A new entry may land with `survivesUntil` only when the hole it records is pre-existing and
// has a finding id.
//
// KEYED BY QUOTED EXPRESSION, NEVER BY `path:line`. A line-keyed list goes red when someone rewraps
// a comment three functions above the guarded code, and people learn to re-baseline it without
// reading. An entry
// names the expression itself. When the expression appears more than once in its file, `anchor`
// names a second quoted expression that occurs EXACTLY ONCE, and the mutated expression is its first
// occurrence after the anchor, within {@link ANCHOR_WINDOW} characters — so deleting the guarded
// line cannot silently re-aim the mutation at a sibling further down the file.
//
// Usage:
//   bun run test:mutations                  # run every entry; exit 1 on any failure above
//   bun run test:mutations <id> [<id> ...]  # run only the named entries
//   bun run test:mutations --list           # print the register without running anything
//
// Suites that need a database read TEST_DATABASE_URL from the environment, as they always do.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** How far past its anchor an expression may start and still be the one the entry means. */
export const ANCHOR_WINDOW = 600;

/**
 * The five ways a distinction collapses. Every entry is one of them. `casing` covers every
 * normalization of a vendor word before it is compared: case, padding, and which words the
 * comparison accepts at all.
 */
export type DistinctionKind =
  | "identity"
  | "casing"
  | "absent-vs-unreadable"
  | "query-scope"
  | "call-made";

export interface MutationEntry {
  /** Stable name, used on the command line and in the report. */
  id: string;
  kind: DistinctionKind;
  /** Repo-relative path of the production file the mutation applies to. */
  path: string;
  /** Optional quoted expression occurring exactly once, used to locate a non-unique `find`. */
  anchor?: string;
  /** The exact quoted expression the mutation replaces. */
  find: string;
  /** What it is replaced with. Must still parse: a syntax error is not a kill. */
  replace: string;
  /** Repo-relative test files, 1-3, that must go red under the mutation. */
  tests: string[];
  /** Why this mutation matters, and the watched red it is based on. */
  why: string;
  /** Finding id that owns a KNOWN hole: the mutant is expected to survive until it is fixed. */
  survivesUntil?: string;
}

export const REGISTER: MutationEntry[] = [
  {
    id: "composio-revoke-asks-under-local-id",
    kind: "identity",
    path: "server/src/plugins/composio-client/consent.ts",
    anchor: "async revoke({ account, toolkit }): Promise<boolean> {",
    find: "const userId = account.vendorUserId;",
    replace: "const userId = account.userId;",
    tests: ["server/tests/composio-adapter.test.ts"],
    why: "A8a: withdrawal must ask Composio under the vendor id. Passed 245/245 before A8a; 18 fail after.",
  },
  {
    id: "composio-is-connected-asks-under-local-id",
    kind: "identity",
    path: "server/src/plugins/composio-client/consent.ts",
    anchor: "async isConnected({ account, toolkit }): Promise<boolean> {",
    find: "const userId = account.vendorUserId;",
    replace: "const userId = account.userId;",
    tests: ["server/tests/composio-adapter.test.ts"],
    why: "A8a: the gate ./access asks before running an action must ask under the vendor id. 0 fail before A8a; 3 after.",
  },
  {
    id: "arcade-connection-status-unfolded",
    kind: "casing",
    // K2: every vendor status is folded in ONE place, `vendorStatusOf` in the transport, so the
    // per-site expressions this entry and the next once quoted are gone. Both re-quote the shared
    // fold; each still names the suites that must see it for ITS reader.
    path: "server/src/plugins/arcade.ts",
    find: 'return { kind: "text", text: value.trim().toLowerCase() };',
    replace: 'return { kind: "text", text: value };',
    tests: [
      "server/tests/arcade-adapter-connections.test.ts",
      "server/tests/arcade-adapter-status.test.ts",
    ],
    why: "A vendor-side change of case or padding on connection_status must not change whether somebody is shown as connected.",
  },
  {
    id: "arcade-mint-status-unfolded",
    kind: "casing",
    path: "server/src/plugins/arcade.ts",
    find: 'return { kind: "text", text: value.trim().toLowerCase() };',
    replace: 'return { kind: "text", text: value };',
    tests: ["server/tests/arcade-authorize-status-engine.test.ts"],
    why: "D6: deleting the fold on the mint's own status was reported to leave arcade-authorize-status-engine green, because :118 asserts only BrokerRefusalError, which the allowlist yields anyway. K2 added padded/re-cased allowlist rows that are handed on only when folded.",
  },
  {
    id: "arcade-mint-not-started-dropped",
    kind: "casing",
    path: "server/src/plugins/arcade-adapter.ts",
    find: 'const MINT_AWAITS_CONSENT_STATUSES = new Set(["not_started", "pending"]);',
    replace: 'const MINT_AWAITS_CONSENT_STATUSES = new Set(["pending"]);',
    tests: ["server/tests/arcade-authorize-status-engine.test.ts"],
    why: "D6: not_started, half the allowlist, is untested — a mint that has not begun would be refused as if it were finished. K2 added the not_started rows.",
  },
  {
    id: "arcade-unreadable-authorization-read-as-none",
    kind: "absent-vs-unreadable",
    // K2 moved `authorizationRequirementOf` into the transport, which both readers import.
    path: "server/src/plugins/arcade.ts",
    anchor:
      'if (typeof authorization !== "object" || Array.isArray(authorization)) {',
    find: 'kind: "unreadable",',
    replace: 'kind: "none",',
    tests: [
      "server/tests/arcade-adapter-status.test.ts",
      "server/tests/arcade-auth-provider.test.ts",
      "server/tests/arcade-adapter-connections.test.ts",
    ],
    why: "C2/C2b: an authorization block that cannot be read is not the vendor saying none — reading it as none silently drops the consent requirement.",
  },
  {
    id: "arcade-unreadable-scopes-read-as-none",
    kind: "absent-vs-unreadable",
    path: "server/src/plugins/arcade.ts",
    find: 'return { kind: "unreadable", field: "scopes", shape: shapeOf(scopes) };',
    replace: 'return { kind: "read", scopes: [] };',
    tests: ["server/tests/arcade-vendor-read-contract.test.ts"],
    why: "K2 (C2c): an unreadable oauth2 scopes value read as [] is 'the connection is the grant' on the gate, the catalogue and the grants screen at once.",
  },
  {
    id: "arcade-missing-token-status-read-as-held",
    kind: "absent-vs-unreadable",
    path: "server/src/plugins/arcade-adapter.ts",
    find: 'if (tokenStatus.kind !== "text") {',
    replace:
      'if (tokenStatus.kind !== "text") return [{ action, state: "authorized", scopes, authorization: "held" }]; if (false) {',
    tests: ["server/tests/arcade-vendor-read-contract.test.ts"],
    why: "K2 (A7c): a token_status the listing did not give read as a held grant marked every action of a configured provider authorized for everyone.",
  },
  {
    id: "arcade-unreadable-status-read-as-absent",
    kind: "absent-vs-unreadable",
    path: "server/src/plugins/arcade.ts",
    find: 'return { kind: "unreadable", shape: shapeOf(value) };',
    replace: 'return { kind: "absent" };',
    tests: [
      "server/tests/arcade-vendor-read-contract.test.ts",
      "server/tests/arcade-authorize-status-engine.test.ts",
    ],
    why: "K2 (A7b, L2-b): a present-but-unreadable vendor status read as silence makes a connection live and hands a mint's bearer url on as a redirect.",
  },
  {
    id: "arcade-auth-providers-skip-unreadable",
    kind: "absent-vs-unreadable",
    path: "server/src/plugins/arcade-adapter.ts",
    find: "unreadable ??= { action, field: read.field, shape: read.shape };",
    replace: "void action;",
    tests: [
      "server/tests/arcade-adapter-connections.test.ts",
      "server/tests/arcade-auth-provider.test.ts",
    ],
    why: "C2b: restoring the silent skip of an unreadable authorization in authProvidersNamedBy turned 3 refusals back into answers (35 pass / 3 fail).",
  },
  {
    id: "composio-account-listing-unscoped-by-person",
    kind: "query-scope",
    path: "server/src/plugins/composio-client/context.ts",
    find: "userIds: [userId],",
    replace: "",
    tests: ["server/tests/composio-adapter.test.ts"],
    why: "A8a: an account listing without its userIds filter reads everybody's accounts as this person's. 5 fail before A8a's honest fakes; 23 after.",
  },
  {
    id: "arcade-connection-listing-unscoped-by-person",
    kind: "query-scope",
    path: "server/src/plugins/arcade-adapter.ts",
    anchor: "client.admin.userConnections.list({",
    find: "user_id: vendorUserId,",
    replace: "",
    tests: [
      "server/tests/arcade-adapter-connections.test.ts",
      "server/tests/arcade-adapter.test.ts",
    ],
    why: "A6b: the connection listing must be scoped to this person, or somebody else's connection answers isConnected and is what revoke deletes.",
  },
  {
    id: "disconnect-never-asks-the-vendor",
    kind: "call-made",
    path: "server/src/plugins/plugin-store/connections.ts",
    find: "const ended = await broker.revoke({",
    replace:
      "const ended = await ((_skipped: unknown) => Promise.resolve(false))({",
    tests: [
      "server/tests/arcade-disconnect-route.test.ts",
      "server/tests/arcade-disconnect-cascade.test.ts",
    ],
    why: "C8c: a disconnect that never asks the vendor to withdraw leaves a live account behind a deleted local row.",
  },
];

/** Where in `source` the entry's expression starts, or a sentence saying why it cannot be found. */
export function locate(
  source: string,
  entry: MutationEntry,
): { index: number } | { error: string } {
  const count = (needle: string) => source.split(needle).length - 1;
  if (entry.anchor === undefined) {
    const n = count(entry.find);
    if (n === 1) return { index: source.indexOf(entry.find) };
    return {
      error:
        n === 0
          ? `${entry.path} no longer contains ${JSON.stringify(entry.find)}. The guarded code changed; re-quote the entry deliberately.`
          : `${entry.path} contains ${JSON.stringify(entry.find)} ${n} times. Give the entry an anchor that occurs exactly once.`,
    };
  }
  const anchors = count(entry.anchor);
  if (anchors !== 1) {
    return {
      error: `${entry.path} contains the anchor ${JSON.stringify(entry.anchor)} ${anchors} times; it must occur exactly once.`,
    };
  }
  const after = source.indexOf(entry.anchor) + entry.anchor.length;
  const index = source.indexOf(entry.find, after);
  if (index === -1 || index - after > ANCHOR_WINDOW) {
    return {
      error: `${entry.path} has no ${JSON.stringify(entry.find)} within ${ANCHOR_WINDOW} characters after ${JSON.stringify(entry.anchor)}. The guarded code changed; re-quote the entry deliberately.`,
    };
  }
  return { index };
}

/** `source` with the entry's mutation applied. Throws when the expression cannot be located. */
export function mutate(source: string, entry: MutationEntry): string {
  const found = locate(source, entry);
  if ("error" in found) throw new Error(found.error);
  return (
    source.slice(0, found.index) +
    entry.replace +
    source.slice(found.index + entry.find.length)
  );
}

interface Run {
  exitCode: number;
  failed: number;
  failNames: string[];
  output: string;
}

const RUN_TIMEOUT_MS = 300_000;

function runTests(files: string[], env: Record<string, string>): Run {
  const preload = join(REPO_ROOT, "scripts", "mutation-register-preload.ts");
  const args = ["bun", "test"];
  if (env.MUTATION_REGISTER_ENTRY) args.push("--preload", preload);
  const proc = Bun.spawnSync([...args, ...files], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: RUN_TIMEOUT_MS,
  });
  const output = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
  const failNames = output
    .split("\n")
    .filter((line) => line.startsWith("(fail)"))
    .map((line) =>
      line.replace(/^\(fail\)\s*/, "").replace(/\s*\[[^\]]*\]$/, ""),
    );
  return {
    exitCode: proc.exitCode ?? -1,
    failed: failNames.length,
    failNames,
    output,
  };
}

type Verdict =
  | "killed"
  | "survived"
  | "not-reached"
  | "unlocatable"
  | "control-red";

interface Outcome {
  entry: MutationEntry;
  verdict: Verdict;
  ok: boolean;
  detail: string;
}

function judge(
  entry: MutationEntry,
  verdict: Verdict,
  detail: string,
): Outcome {
  if (verdict === "killed") {
    return entry.survivesUntil
      ? {
          entry,
          verdict,
          ok: false,
          detail: `${detail}. STALE DEBT: the suite now catches this; delete survivesUntil "${entry.survivesUntil}".`,
        }
      : { entry, verdict, ok: true, detail };
  }
  if (verdict === "survived" && entry.survivesUntil) {
    return {
      entry,
      verdict,
      ok: true,
      detail: `known hole, owned by ${entry.survivesUntil}`,
    };
  }
  return { entry, verdict, ok: false, detail };
}

function main(argv: string[]): number {
  if (argv.includes("--list")) {
    for (const e of REGISTER) {
      console.log(
        `${e.id}  [${e.kind}]  ${e.path}${e.survivesUntil ? `  survivesUntil ${e.survivesUntil}` : ""}`,
      );
    }
    return 0;
  }
  const wanted = argv.filter((a) => !a.startsWith("--"));
  const unknown = wanted.filter((id) => !REGISTER.some((e) => e.id === id));
  if (unknown.length > 0) {
    console.error(`No register entry named ${unknown.join(", ")}.`);
    return 1;
  }
  const entries = wanted.length
    ? REGISTER.filter((e) => wanted.includes(e.id))
    : REGISTER;

  const controls = new Map<string, Run>();
  const outcomes: Outcome[] = [];
  const markDir = mkdtempSync(join(tmpdir(), "mutation-register-"));
  try {
    for (const entry of entries) {
      const target = join(REPO_ROOT, entry.path);
      const before = readFileSync(target, "utf8");
      const found = locate(before, entry);
      if ("error" in found) {
        outcomes.push(judge(entry, "unlocatable", found.error));
        continue;
      }
      const key = [...entry.tests].sort().join(" ");
      let control = controls.get(key);
      if (!control) {
        process.stdout.write(`control  ${key} ... `);
        control = runTests(entry.tests, {});
        controls.set(key, control);
        console.log(control.exitCode === 0 ? "green" : "RED");
      }
      if (control.exitCode !== 0) {
        outcomes.push(
          judge(
            entry,
            "control-red",
            `the named suites fail WITHOUT the mutation (${control.failed} failing), so a kill would prove nothing:\n${control.failNames.join("\n")}`,
          ),
        );
        continue;
      }
      const mark = join(markDir, entry.id);
      process.stdout.write(`mutant   ${entry.id} ... `);
      const run = runTests(entry.tests, {
        MUTATION_REGISTER_ENTRY: entry.id,
        MUTATION_REGISTER_MARK: mark,
      });
      if (readFileSync(target, "utf8") !== before) {
        // The preload never writes, so this is a bug in the register itself. Say so loudly.
        throw new Error(
          `${entry.path} changed on disk during the mutant run. Inspect it with git diff.`,
        );
      }
      let outcome: Outcome;
      if (!existsSync(mark)) {
        outcome = judge(
          entry,
          "not-reached",
          `the named suites never imported ${entry.path}, so the mutation was never applied. Name a suite that exercises it.\n${run.output.slice(-2000)}`,
        );
      } else if (run.failed > 0) {
        outcome = judge(entry, "killed", `${run.failed} test(s) failed`);
      } else {
        outcome = judge(
          entry,
          "survived",
          run.exitCode === 0
            ? "every named test still passes with the distinction broken: COVERAGE HOLE"
            : `no test failed (exit ${run.exitCode}); a crash is not a kill:\n${run.output.slice(-2000)}`,
        );
      }
      console.log(outcome.verdict.toUpperCase());
      outcomes.push(outcome);
    }
  } finally {
    rmSync(markDir, { recursive: true, force: true });
  }

  console.log("");
  for (const o of outcomes) {
    console.log(
      `${o.ok ? "ok  " : "FAIL"}  ${o.verdict.padEnd(11)}  ${o.entry.id}  — ${o.detail}`,
    );
  }
  const failures = outcomes.filter((o) => !o.ok).length;
  console.log(
    `\n${outcomes.length - failures} ok, ${failures} failing, of ${outcomes.length} entries.`,
  );
  return failures === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
