// server/tests/assertion-shape.test.ts
/**
 * ASSERTIONS THAT CANNOT FAIL ON THEIR OWN SUBJECT, read off the source rather than run.
 *
 * Two review rounds turned up some two dozen assertions that pass whatever the code under test
 * does. Nothing in this repo could have caught them: `server/tests` is outside `tsc`, the lint set
 * carries no floating-assertion rule, and the red-green protocol proves that ONE assertion can
 * fail, never its siblings. So a test can be green because it asserts nothing, and stay green
 * forever, and no gate in the repo has an opinion about it.
 *
 * Six of those families have a SYNTACTIC shape — visible in the text, with nothing executed:
 *
 *   (a) a `.rejects` / `.resolves` neither awaited nor returned. The matcher runs on a promise
 *       nobody waits for; the test ends first and the rejection lands in no assertion.
 *   (b) a `?.` in an `expect(…)` subject under a matcher that `undefined` satisfies
 *       (`toBeUndefined`, `toBeFalsy`, `not.toBeDefined`, `toBe(undefined)`). If the subject is
 *       null the chain short-circuits to exactly the value being asserted, so the assertion holds
 *       whether or not the subject ever existed.
 *   (c) a `toEqual` whose EXPECTED literal holds an `undefined` value. Measured on bun 1.4.2:
 *       `expect({}).toEqual({ a: undefined })` passes — an expected-`undefined` key asserts
 *       nothing, so those keys are decoration.
 *   (d) a test every one of whose assertions is lexically inside an `if`, with no `throw` outside
 *       the branches. When no branch is taken the test asserts nothing and still passes.
 *   (e) a module-level `const`/`let` written by a stub and never read anywhere — a value recorded
 *       so carefully that nothing ever looks at it.
 *   (f) `JSON.stringify(x, Object.keys(x))`. The replacer array applies at EVERY depth, and a
 *       plain `Error` has no own enumerable keys, so the whole thing is `"{}"` and any
 *       `.not.toContain(secret)` over it passes on an empty string.
 *
 * WHY (b) IS THE STRICT SUBSET. `expect(row?.x).not.toBeNull()` is the same family — it passes
 * when `row` is undefined — and the repo holds about 130 of them. This guard takes only the
 * sites where the short-circuit value IS the asserted value, which is the form that can never
 * fail rather than the form that is merely weak. The wider family is noted for the audit, not
 * policed here, because a guard whose allow-list is 130 lines long is a wall and not a guard.
 *
 * WHY IT LANDS WITH AN ALLOW-LIST. Fixing the offenders here would hide them from the fix cycle
 * that owns them, and a guard that fails on arrival gets disabled rather than obeyed. So every
 * offence this scan finds today is listed below with its finding id, and ONE ground covers every
 * entry: it predates the guard and belongs to the fix cycle. The list is checked both ways — an
 * unlisted offence fails, and so does a listed one the fix cycle has already cleared, so the list
 * shrinks as the fixes land and cannot quietly rot.
 *
 * HOW IT READS THE SOURCE. Through `support/source-scan.ts`, the shared scanner, and not a sixth
 * private copy of the enumerator: `sourceFiles` walks recursively, and `stripComments` blanks a
 * comment WHERE IT STANDS, which is what lets this file work in byte offsets at all — every
 * position in the stripped text is the position in the file, so a reported line is the line a
 * reader is sent to. Matching is by offset rather than by line because these shapes are longer
 * than lines: a `toEqual` literal or an `if` block runs past any join limit. `logicalLines`
 * supplies the quoted expression in the message, where a wrapped expression should read as one.
 *
 * The positive controls below plant each shape in a fixture tree on disk and run the WHOLE scan
 * over it — walk, strip, match — rather than handing a string to a matcher. A control that only
 * feeds the matcher proves the matcher; the enumerator is where the other guards in this repo
 * went blind.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  logicalLines,
  sourceFiles,
  stripComments,
} from "./support/source-scan";

/** Which of the six shapes an offence is. */
export type Shape = "a" | "b" | "c" | "d" | "e" | "f";

/** One offence: where it is, which shape, and the expression as the file reads it. */
export type Offence = {
  file: string;
  line: number;
  shape: Shape;
  text: string;
};

function blankLiterals(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") {
          out += "  ";
          j += 2;
          continue;
        }
        if (text[j] === c) break;
        if (c !== "`" && text[j] === "\n") break;
        // A `${…}` hole is CODE, and a value read only there is still read.
        if (c === "`" && text[j] === "$" && text[j + 1] === "{") {
          let depth = 0;
          const from = j;
          for (; j < text.length; j++) {
            if (text[j] === "{") depth++;
            else if (text[j] === "}") {
              depth--;
              if (depth === 0) {
                j++;
                break;
              }
            }
          }
          out += text.slice(from, j);
          continue;
        }
        out += text[j] === "\n" ? "\n" : " ";
        j++;
      }
      if (j < text.length && text[j] === c) {
        out += c;
        j++;
      }
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
function closerOf(code: string, open: number): number {
  const stack: string[] = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (OPEN[c]) stack.push(OPEN[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

function lineOf(code: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < code.length; i++) if (code[i] === "\n") n++;
  return n;
}

function statementStart(code: string, index: number): number {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const c = code[i];
    if (c === ")" || c === "]") depth++;
    else if (c === "(" || c === "[") {
      if (depth > 0) depth--;
    } else if (depth === 0 && (c === ";" || c === "{" || c === "}"))
      return i + 1;
  }
  return 0;
}

function statementEnd(code: string, index: number): number {
  let depth = 0;
  for (let i = index; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth > 0) depth--;
      else return i;
    } else if (depth === 0 && c === ";") return i;
  }
  return code.length;
}

function topLevelArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (OPEN[c]) depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      args.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  args.push(inner.slice(start));
  return args.map((a) => a.trim());
}

const MUTATORS = [
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "add",
  "set",
  "delete",
  "clear",
  "fill",
  "sort",
];

/** Matchers that `undefined` satisfies. */
const UNDEFINED_PASSES = /^(?:toBeUndefined|toBeFalsy|toBeNil|toBeNullish)$/;

type Range = { start: number; end: number };

export function offencesIn(file: string, source: string): Offence[] {
  const stripped = stripComments(source);
  const code = blankLiterals(stripped);
  const found: Offence[] = [];
  // The logical line an offence sits in, for the message: a wrapped expression reads as one.
  const joined = logicalLines(stripped);
  const quote = (line: number) => {
    let best = "";
    for (const l of joined) {
      if (l.line > line) break;
      best = l.text;
    }
    return best.trim().replace(/\s+/g, " ").slice(0, 110);
  };
  const at = (index: number, shape: Shape) => {
    const line = lineOf(code, index);
    found.push({ file, line, shape, text: quote(line) });
  };

  const expects: { index: number; open: number; close: number }[] = [];
  for (const m of code.matchAll(/\bexpect\s*\(/g)) {
    const index = m.index as number;
    const open = index + m[0].length - 1;
    const close = closerOf(code, open);
    if (close > 0) expects.push({ index, open, close });
  }

  // (a) a floating .rejects / .resolves
  for (const m of code.matchAll(/\.(?:rejects|resolves)\b/g)) {
    const i = m.index as number;
    const start = statementStart(code, i);
    const head = code.slice(start, i);
    const own = head.lastIndexOf("expect");
    if (own < 0) continue;
    const prefix = head.slice(0, own);
    if (/\b(?:await|return|yield)\b/.test(prefix)) continue;
    if (/=>\s*$/.test(prefix)) continue;
    at(start + (head.length - head.trimStart().length), "a");
  }

  // (b) `?.` in the subject, under a matcher `undefined` satisfies
  for (const e of expects) {
    if (!code.slice(e.open + 1, e.close).includes("?.")) continue;
    const chain = /^((?:\s*\.\s*[A-Za-z_$][\w$]*)+)\s*\(/.exec(
      code.slice(e.close + 1),
    );
    if (!chain) continue;
    const parts = chain[1]
      .split(".")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.includes("rejects") || parts.includes("resolves")) continue;
    const matcher = parts[parts.length - 1];
    const negated = parts.includes("not");
    const argOpen = e.close + 1 + chain[0].length - 1;
    const argClose = closerOf(code, argOpen);
    const arg = argClose > 0 ? code.slice(argOpen + 1, argClose).trim() : "";
    const undefinedIsThePass = negated
      ? matcher === "toBeDefined"
      : UNDEFINED_PASSES.test(matcher) || arg === "undefined";
    if (undefinedIsThePass) at(e.index, "b");
  }

  // (c) toEqual over an expected literal holding `undefined`
  for (const m of code.matchAll(/\btoEqual\s*\(/g)) {
    const open = (m.index as number) + m[0].length - 1;
    const close = closerOf(code, open);
    if (close < 0) continue;
    if (/:\s*undefined\s*[,}]/.test(code.slice(open + 1, close)))
      at(m.index as number, "c");
  }

  // guarded regions: the statement an `if` controls
  const guards: Range[] = [];
  for (const m of code.matchAll(/(?<![.\w$])if\s*\(/g)) {
    const open = (m.index as number) + m[0].length - 1;
    const close = closerOf(code, open);
    if (close < 0) continue;
    let j = close + 1;
    while (j < code.length && /\s/.test(code[j])) j++;
    const end = code[j] === "{" ? closerOf(code, j) : statementEnd(code, j);
    if (end < 0) continue;
    guards.push({ start: m.index as number, end });
  }

  // (d) a test whose every assertion sits inside an `if`
  for (const m of code.matchAll(
    /(?<![.\w$])(?:test|it)(?:\s*\.\s*\w+)*\s*\(/g,
  )) {
    let open = (m.index as number) + m[0].length - 1;
    let close = closerOf(code, open);
    if (close < 0) continue;
    // test.each([...])(name, body): the body lives in the SECOND call.
    let next = close + 1;
    while (next < code.length && /\s/.test(code[next])) next++;
    if (code[next] === "(") {
      open = next;
      close = closerOf(code, open);
      if (close < 0) continue;
    }
    const inside = expects.filter((e) => e.index > open && e.index < close);
    if (inside.length === 0) continue;
    const unguarded = (i: number) =>
      !guards.some((g) => g.start > open && i > g.start && i < g.end);
    // An explicit `throw` outside every branch is a failure path of its own.
    const throws = [...code.matchAll(/(?<![.\w$])throw\s/g)].some(
      (t) =>
        (t.index as number) > open &&
        (t.index as number) < close &&
        unguarded(t.index as number),
    );
    if (throws) continue;
    if (
      inside.every((e) =>
        guards.some(
          (g) => g.start > open && e.index > g.start && e.index < g.end,
        ),
      )
    )
      at(m.index as number, "d");
  }

  // (e) a module-level recorder nothing asserts.
  //
  // "Never read by an expect" is widened to "never read at all", which is the same set and one a
  // reader can check: a value read somewhere else is at least wired to something, and the shape
  // this looks for is the stub that records into a variable no line of the file ever opens.
  for (const m of code.matchAll(
    /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:\[\s*\]|\{\s*\}|false|true|0|null|""|'')\s*;/gm,
  )) {
    const name = m[1];
    const decl = m.index as number;
    let writes = 0;
    let reads = 0;
    for (const u of code.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
      const i = u.index as number;
      if (i === decl + m[0].indexOf(name)) continue;
      const prev = code[i - 1] ?? " ";
      if (/[\w$]/.test(prev)) continue;
      // `.name` is somebody else's property; `...name` is a read of this one.
      if (prev === "." && code[i - 2] !== ".") continue;
      // Only a value nobody consumes is a write: `x.push(y);` is, `for (… of x.splice(0))` is not.
      const before = code.slice(0, i).trimEnd();
      const statementPosition = before === "" || /[;{}]$/.test(before);
      let j = i + name.length;
      let mutator = false;
      for (;;) {
        const rest = code.slice(j);
        const prop = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(rest);
        if (prop) {
          mutator = MUTATORS.includes(prop[1]);
          j += prop[0].length;
          continue;
        }
        const idx = /^\s*\[[^\]]*\]/.exec(rest);
        if (idx) {
          mutator = false;
          j += idx[0].length;
          continue;
        }
        break;
      }
      const after = code.slice(j);
      const assigned = /^\s*=[^=>]/.test(after);
      const called = mutator && /^\s*\(/.test(after);
      if (statementPosition && (assigned || called)) writes++;
      else reads++;
    }
    if (writes > 0 && reads === 0) at(decl, "e");
  }

  // (f) JSON.stringify(x, Object.keys(x))
  for (const m of code.matchAll(/\bJSON\.stringify\s*\(/g)) {
    const open = (m.index as number) + m[0].length - 1;
    const close = closerOf(code, open);
    if (close < 0) continue;
    const args = topLevelArgs(code.slice(open + 1, close));
    if (args.length >= 2 && /^Object\.keys\s*\(/.test(args[1]))
      at(m.index as number, "f");
  }

  return found.sort(
    (x, y) => x.line - y.line || x.shape.localeCompare(y.shape),
  );
}

const REPO = join(import.meta.dir, "..", "..");
const ROOTS = ["server/tests", "app/tests"];
const EXTENSIONS = [".ts", ".tsx"];

/** Every offence under `root`, with each file named relative to `from`. */
export function scanTree(root: string, from = root): Offence[] {
  const found: Offence[] = [];
  for (const file of sourceFiles(root, EXTENSIONS)) {
    const named = file.startsWith(`${from}/`)
      ? file.slice(from.length + 1)
      : file;
    found.push(...offencesIn(named, readFileSync(file, "utf8")));
  }
  return found;
}

/**
 * An offence this guard does NOT fail on.
 *
 * One ground covers every entry below and no other ground is accepted: the offence predates this
 * guard, so it is fix-cycle work rather than a licence. `finding` names the review that found it,
 * or marks it as one this scan turned up that the review rounds did not. `why` quotes the
 * expression, so an entry can be read without opening the file.
 */
type Allowed = {
  file: string;
  line: number;
  shape: Shape;
  finding: string;
  why: string;
};

const key = (o: { file: string; line: number; shape: Shape }) =>
  `${o.file}:${o.line}:${o.shape}`;

/**
 * THE STANDING OFFENDERS, as of the commit that added this file.
 *
 * Three further round-2 findings are NOT here, because they have no syntactic shape and this scan
 * cannot see them — they stay with the fix cycle on the review's word alone:
 *   - `server/tests/composio-adapter.test.ts:8484` — a literal pinned two lines above its own
 *     assertion, which is a reading of the file rather than a shape in it.
 *   - `server/tests/arcade-live.test.ts:542` — `need(x ?? 0, …)` cannot throw, because the `??`
 *     supplies the value whose absence `need` exists to refuse.
 *   - `server/tests/server-side-tools.integration.test.ts:196-200` — an audit-event assertion
 *     scoped to no run, which is a question about the query and not about the syntax.
 * And one round-2 finding is not reproduced: `plugin-user-credential.integration.test.ts:475` was
 * reported as shape (a), but that test's `.rejects` (at :489-491) IS awaited. Its sibling at :361
 * is the real one and is listed below.
 */
const ALLOW: Allowed[] = [
  {
    file: "app/tests/auth-client.test.ts",
    line: 83,
    shape: "a",
    finding: "round 2 — auth-client.test.ts, six sites",
    why: 'expect(signInWith("okta", refuse)).rejects.toThrow( "That provider is not configured.", );',
  },
  {
    file: "app/tests/auth-client.test.ts",
    line: 97,
    shape: "a",
    finding: "round 2 — auth-client.test.ts, six sites",
    why: 'test("names the provider when the client says nothing", async () => { const refuse = async () => ({ error: {} ',
  },
  {
    file: "app/tests/auth-client.test.ts",
    line: 101,
    shape: "a",
    finding: "round 2 — auth-client.test.ts, six sites",
    why: 'test("resolves quietly when the redirect is under way", async () => { expect( signInWith("google", async () =>',
  },
  {
    file: "app/tests/auth-client.test.ts",
    line: 162,
    shape: "a",
    finding: "round 2 — auth-client.test.ts, six sites",
    why: 'expect( signInWithEmailDomain("someone@company.com", refuse), ).rejects.toThrow("That domain is registered to ',
  },
  {
    file: "app/tests/auth-client.test.ts",
    line: 170,
    shape: "a",
    finding: "round 2 — auth-client.test.ts, six sites",
    why: 'test("says no provider is registered when the client says nothing", async () => { const refuse = async () => (',
  },
  {
    file: "app/tests/auth-client.test.ts",
    line: 176,
    shape: "a",
    finding: "round 2 — auth-client.test.ts, six sites",
    why: 'test("resolves quietly when the redirect is under way", async () => { expect( signInWithEmailDomain("someone@c',
  },
  {
    file: "server/tests/audit-initiator.integration.test.ts",
    line: 291,
    shape: "a",
    finding: "NEW (round 2 did not find this)",
    why: "expect(reattribute()).rejects.toThrow();",
  },
  {
    file: "server/tests/component-store.integration.test.ts",
    line: 149,
    shape: "a",
    finding: "NEW (round 2 did not find this)",
    why: 'test("withholding a component that does not exist is an error, not a silent row", async () => { expect( store.',
  },
  {
    file: "server/tests/component-store.integration.test.ts",
    line: 372,
    shape: "a",
    finding: "NEW (round 2 did not find this)",
    why: 'test("revoking from a component that does not exist is an error, not a silent no-op", async () => { expect(sto',
  },
  {
    file: "server/tests/component-store.integration.test.ts",
    line: 404,
    shape: "a",
    finding: "NEW (round 2 did not find this)",
    why: 'test("a function this build does not ship cannot be run", async () => { expect(store.callFunction(`nothing_${s',
  },
  {
    file: "server/tests/computer-client.test.ts",
    line: 263,
    shape: "a",
    finding: "NEW (round 2 did not find this)",
    why: 'test("is its own condition, not an unavailable computer", async () => { expect( timingOut().click({ ref: "e5",',
  },
  {
    file: "server/tests/computer-client.test.ts",
    line: 305,
    shape: "a",
    finding: "NEW (round 2 did not find this)",
    why: 'test("is a person holding the wheel when the computer says so", async () => { expect( refusing({ error: "A per',
  },
  {
    file: "server/tests/computer-client.test.ts",
    line: 316,
    shape: "a",
    finding: "NEW (round 2 did not find this)",
    why: 'test("is a stale snapshot when it does not", async () => { expect( refusing({ error: "Snapshot 3 is not the cu',
  },
  {
    file: "server/tests/computer-client.test.ts",
    line: 334,
    shape: "a",
    finding: "NEW (round 2 did not find this)",
    why: 'expect( refusing(body).click({ ref: "e1", snapshotId: 1 }), ).rejects.toBeInstanceOf(StaleSnapshotError);',
  },
  {
    file: "server/tests/computer-client.test.ts",
    line: 342,
    shape: "a",
    finding: "NEW (round 2 did not find this)",
    why: 'test("a 409 with no body at all is still a refusal, not a crash", async () => { const bodyless = clientWith(()',
  },
  {
    file: "server/tests/computer-supervisor.test.ts",
    line: 65,
    shape: "a",
    finding: "NEW (round 2 did not find this)",
    why: 'expect(client.locate("sales")).rejects.toThrow(SupervisorError);',
  },
  {
    file: "server/tests/computer-supervisor.test.ts",
    line: 75,
    shape: "a",
    finding: "NEW (round 2 did not find this)",
    why: 'expect(client.locate("bad id")).rejects.toThrow( "A bot id may contain only letters.", );',
  },
  {
    file: "server/tests/computer-supervisor.test.ts",
    line: 89,
    shape: "a",
    finding: "NEW (round 2 did not find this)",
    why: 'expect(client.locate("sales")).rejects.toThrow(/could not be reached/);',
  },
  {
    file: "server/tests/people-last-sign-in.integration.test.ts",
    line: 127,
    shape: "a",
    finding: "NEW (round 2 did not find this)",
    why: 'expect( stampSignIn(broken, "anybody", SIGNED_IN_AT), ).resolves.toBeUndefined();',
  },
  {
    file: "server/tests/plugin-user-credential.integration.test.ts",
    line: 369,
    shape: "a",
    finding: "round 2 — plugin-user-credential.integration.test.ts:361",
    why: 'describe("a person who has not connected", () => { test("is refused, and told to connect rather than told it b',
  },
  {
    file: "app/tests/bot-setup.test.tsx",
    line: 178,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(updates[0]?.endpoint).toBeUndefined();",
  },
  {
    file: "app/tests/voice-archive.test.ts",
    line: 98,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(records[0]?.saveState).toBeUndefined();",
  },
  {
    file: "app/tests/voice-archive.test.ts",
    line: 149,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: 'expect((await loadVoiceArchive("channel-1"))[0]?.saveState).toBeUndefined();',
  },
  {
    file: "server/tests/agent-endpoint.test.ts",
    line: 483,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(forwarded.forwardedProps?.openbotRun).toBeUndefined();",
  },
  {
    file: "server/tests/agent-escalation.test.ts",
    line: 78,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(written[0]?.initiator).toBe(undefined);",
  },
  {
    file: "server/tests/agent-handoff.test.ts",
    // Moved from 366 by the work-list change, which added tests above it; the offence is the same one and
    // is re-keyed rather than re-found.
    line: 409,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(plain.events[0]?.initiator).toBe(undefined);",
  },
  {
    file: "server/tests/approvals-interactive.integration.test.ts",
    line: 229,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(continued[0]?.error).toBeUndefined();",
  },
  {
    file: "server/tests/approvals-policy.test.ts",
    line: 779,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(continued[0]?.error).toBeUndefined();",
  },
  {
    file: "server/tests/arcade-adapter-errors.test.ts",
    line: 63,
    shape: "b",
    finding: "round 2 — arcade-adapter-errors.test.ts:62-66",
    why: 'test("a connection failure keeps status undefined", () => { expect( normalizeArcadeError(new APIConnectionErro',
  },
  {
    file: "server/tests/arcade-sibling-collateral.test.ts",
    line: 417,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(row(t.gmail)?.payload.endedWith).toBeUndefined();",
  },
  {
    file: "server/tests/arcade-sibling-collateral.test.ts",
    line: 421,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(row(t.slack)?.payload.endedWith).toBeUndefined();",
  },
  {
    file: "server/tests/audit-export.test.ts",
    line: 181,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(seen[0]?.cursor).toBeUndefined();",
  },
  {
    file: "server/tests/computer-gateway.test.ts",
    line: 381,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(rows[0]?.actorUserId).toBeUndefined();",
  },
  {
    file: "server/tests/computer-gateway.test.ts",
    line: 443,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(rows[0]?.payload.element).toBeUndefined();",
  },
  {
    file: "server/tests/computer-gateway.test.ts",
    line: 646,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(rows.at(-1)?.payload.element).toBeUndefined();",
  },
  {
    file: "server/tests/computer-provider.test.ts",
    line: 356,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: 'expect(await provider.sessionOf?.("sales")).toBeUndefined();',
  },
  {
    file: "server/tests/computer-provider.test.ts",
    line: 365,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: 'expect(await provider.sessionOf?.("sales")).toBeUndefined();',
  },
  {
    file: "server/tests/computer-sandbox.test.ts",
    line: 79,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: 'expect( await providerWith(suspended).sessionOf?.("knowledge"), ).toBeUndefined();',
  },
  {
    file: "server/tests/headless-components.integration.test.ts",
    line: 350,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(bar?.hidden).toBeUndefined();",
  },
  {
    file: "server/tests/headless-components.test.ts",
    line: 202,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(bar?.hidden).toBeUndefined();",
  },
  {
    file: "server/tests/identity-retire.integration.test.ts",
    line: 124,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(audit.rows[0]?.actorUserId).toBeUndefined();",
  },
  {
    file: "server/tests/identity-retire.integration.test.ts",
    line: 247,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(audit.rows[0]?.actorUserId).toBeUndefined();",
  },
  {
    file: "server/tests/mcp-listing.test.ts",
    line: 168,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(fetch?.effect).toBeUndefined();",
  },
  {
    file: "server/tests/mcp-listing.test.ts",
    line: 179,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(search?.effect).toBeUndefined();",
  },
  {
    file: "server/tests/mcp-listing.test.ts",
    line: 180,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(search?.destructive).toBeUndefined();",
  },
  {
    file: "server/tests/picked-harness-auth.test.ts",
    line: 290,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: 'test("a plan\'s installed picked harness authenticates without advertising a bundled Bot", async () => { const ',
  },
  {
    file: "server/tests/picked-harness-auth.test.ts",
    line: 355,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(result.config.managedAgent?.endpoint).toBeUndefined();",
  },
  {
    file: "server/tests/plugin-catalogue.test.ts",
    line: 210,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(entry?.transport).toBeUndefined();",
  },
  {
    file: "server/tests/shared-computer-run.integration.test.ts",
    line: 264,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: 'expect((await snapshots.load("bot-1"))?.session).toBeUndefined();',
  },
  {
    file: "server/tests/tenant-package.test.ts",
    line: 358,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(tenantPackage.agents[1]?.avatarSeed).toBeUndefined();",
  },
  {
    file: "server/tests/tool-selection.integration.test.ts",
    line: 834,
    shape: "b",
    finding: "NEW (round 2 did not find this)",
    why: "expect(run?.forwardedProps?.openbotRun).toBeUndefined();",
  },
  {
    file: "app/tests/user-preferences.test.tsx",
    line: 75,
    shape: "c",
    finding: "NEW (round 2 did not find this)",
    why: 'test("loads preferences from the account and renders the saved emphasis", async () => { const { view } = setup',
  },
  {
    file: "server/tests/agent-handoff.test.ts",
    // Moved from 620 by the work-list change, which added tests above it; the offence is the same one and
    // is re-keyed rather than re-found.
    line: 663,
    shape: "c",
    finding: "NEW (round 2 did not find this)",
    why: ').toEqual([ { eventType: "agent.handoff_offered", reason: undefined }, { eventType: "agent.handoff_refused", r',
  },
  {
    file: "server/tests/agent-test-connection-headers.test.ts",
    line: 12,
    shape: "c",
    finding: "NEW (round 2 did not find this)",
    why: 'describe("parseConnectionHeaders", () => { test("absent headers stay absent", () => { expect(parseConnectionHe',
  },
  {
    file: "server/tests/arcade-adapter-errors.test.ts",
    line: 55,
    shape: "c",
    finding: "round 2 — arcade-adapter-errors.test.ts:50-60",
    why: ").toEqual({",
  },
  {
    file: "server/tests/composio-adapter.test.ts",
    // Moved from 5412 by OB-05, which added fifteen lines of tests above it, then back three by the
    // Plugins screen, which shortened a test above it; the offence is the same one and is re-keyed
    // rather than re-found.
    line: 5424,
    shape: "c",
    finding: "NEW (round 2 did not find this)",
    why: 'expect( await actions.listActions("gmail", { limit: WHOLE_LISTING }), ).toEqual([ { slug: "GMAIL_FETCH_EMAILS"',
  },
  {
    file: "server/tests/composio-adapter.test.ts",
    // Moved from 5458 by OB-05, which added fifteen lines of tests above it, then back three by the
    // Plugins screen, which shortened a test above it; the offence is the same one and is re-keyed
    // rather than re-found.
    line: 5470,
    shape: "c",
    finding: "NEW (round 2 did not find this)",
    why: 'expect( await actions.listActions("gmail", { limit: WHOLE_LISTING }), ).toEqual([ { slug: "GMAIL_FETCH_EMAILS"',
  },
  {
    file: "server/tests/computer-gateway.test.ts",
    line: 808,
    shape: "c",
    finding: "NEW (round 2 did not find this)",
    why: 'expect(result).toEqual({ isolation: "per-bot", computers: [ { botId: "bot-proxied",',
  },
  {
    file: "server/tests/demonstrations.test.ts",
    line: 294,
    shape: "c",
    finding: "NEW (round 2 did not find this)",
    why: 'expect(created).toEqual([ { ownerUserId: "owner", agentId: "bot", instruction: demonstrationRoutineInstruction',
  },
  {
    file: "server/tests/routine-runner.test.ts",
    // Moved from 169 by the work-list change, which added tests above it; the offence is the same one and
    // is re-keyed rather than re-found.
    line: 185,
    shape: "c",
    finding: "NEW (round 2 did not find this)",
    why: 'expect(recorded.finished).toEqual([ { runId: RUN_ID, status: "succeeded", error: undefined }, ]);',
  },
  {
    file: "server/tests/routine-runner.test.ts",
    // Moved from 272 by the work-list change, which added tests above it; the offence is the same one and
    // is re-keyed rather than re-found.
    line: 289,
    shape: "c",
    finding: "NEW (round 2 did not find this)",
    why: 'expect(recorded.finished).toEqual([ { runId: RUN_ID, status: "succeeded", error: undefined }, ]);',
  },
  {
    file: "app/tests/connected-accounts-authorized-notice.test.tsx",
    line: 104,
    shape: "d",
    finding: "round 2 — connected-accounts-authorized-notice.test.tsx:103-115",
    why: 'test.each([ "no-attempt", "toString", "constructor", "__proto__",',
  },
  {
    file: "app/tests/connected-account-grants.test.tsx",
    line: 126,
    shape: "e",
    finding: "NEW (round 2 did not find this)",
    why: "const siblingReads: string[] = [];",
  },
  /*
   * `server/tests/arcade-attempt-store.integration.test.ts:81` — `const actors: string[] = []`,
   * written and never read — is GONE rather than renumbered. The list it collects is now read by
   * the `removePeople` in that file's `afterAll`: `pending_authorizations.actor_id` keys to `users`
   * and cascades, so the ids the suite invents are people it has to create and then take away, and
   * the collection that was decorative is now what the cleanup runs on.
   */
  {
    file: "server/tests/arcade-disconnect-cascade.test.ts",
    // Moved from 36 by round 2's A5 fix, which added three tests above it; the offence is the
    // same one and is re-keyed rather than re-found.
    line: 39,
    shape: "e",
    finding: "round 2 — arcade-disconnect-cascade.test.ts:36,60",
    why: "const revoked: string[] = [];",
  },
  {
    file: "server/tests/arcade-grants-route.test.ts",
    line: 139,
    shape: "e",
    finding: "NEW (round 2 did not find this)",
    why: "const toolkits: string[] = [];",
  },
  {
    file: "server/tests/arcade-grants-route.test.ts",
    line: 140,
    shape: "e",
    finding: "NEW (round 2 did not find this)",
    why: "const viewers: string[] = [];",
  },
  {
    file: "server/tests/enterprise-controls.integration.test.ts",
    line: 59,
    shape: "e",
    finding: "NEW (round 2 did not find this)",
    why: "const stopped: string[] = []; — pushed to at :65, cleared at :718, read nowhere; the `.stopped` at :704 and :720 is the response's own field",
  },
  {
    file: "server/tests/arcade-vendor-error-engine.test.ts",
    line: 186,
    shape: "f",
    finding: "round 2 — arcade-vendor-error-engine.test.ts:174",
    why: 'expect( JSON.stringify(thrown, Object.keys(thrown as object)), ).not.toContain("SECRET-BEARER");',
  },
];

/** One offence per line, the way a reader wants to see it. */
const report = (
  offences: { shape: Shape; file: string; line: number; text: string }[],
) => offences.map((o) => `(${o.shape}) ${o.file}:${o.line}  ${o.text}`).sort();

/* THE GUARD ITSELF. */

for (const root of ROOTS) {
  test(`${root} grows no assertion shape the fix cycle does not already own`, () => {
    const allowed = new Set(ALLOW.map(key));
    const scanned = scanTree(join(REPO, root), REPO);
    expect(report(scanned.filter((o) => !allowed.has(key(o))))).toEqual([]);
    // And the walk reached the tree at all: a scan of nothing reports nothing.
    expect(sourceFiles(join(REPO, root), EXTENSIONS).length).toBeGreaterThan(
      20,
    );
  });
}

test("the allow-list holds no offence the fix cycle has already cleared", () => {
  const found = new Set(
    ROOTS.flatMap((root) => scanTree(join(REPO, root), REPO)).map(key),
  );
  const stale = ALLOW.filter((entry) => !found.has(key(entry)));
  // A fixed offence must leave the list with its fix, or the list stops meaning anything.
  expect(stale.map((entry) => `${key(entry)}  ${entry.finding}`)).toEqual([]);
});

/* POSITIVE CONTROLS.
 *
 * Each plants one shape in a file on disk, at a nesting and an extension the real trees have, and
 * runs the WHOLE scan over the fixture root. A control that hands a string to the matcher proves
 * the matcher; this one has to survive the walk and the stripper to be seen at all. */

let FIXTURES = "";

/** Write `text` at `rel` under the fixture root, creating the directories it needs. */
function fixture(rel: string, text: string): void {
  const full = join(FIXTURES, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text, "utf8");
}

/** The one offence of a shape in the fixture tree, or a failure naming what the scan did see. */
function planted(shape: Shape): Offence {
  const hits = scanTree(FIXTURES).filter((o) => o.shape === shape);
  expect(report(hits)).toHaveLength(1);
  return hits[0];
}

beforeAll(() => {
  FIXTURES = mkdtempSync(join(tmpdir(), "assertion-shape-"));

  fixture(
    "a/floating.ts",
    `test("the refusal is refused", () => {
  expect(refuse()).rejects.toThrow(Boom);
});
`,
  );

  fixture(
    "nested/deep/b/chain.ts",
    `test("a connection failure keeps status undefined", () => {
  expect(normalize(failure)?.status).toBeUndefined();
});
`,
  );

  fixture(
    "c/equal.tsx",
    `test("an error with no body leaves name undefined", () => {
  expect(read()).toEqual({
    status: 500,
    name: undefined,
  });
});
`,
  );

  fixture(
    "d/guarded.tsx",
    `test("a sentence or nothing, never an object", () => {
  const notice = noticeFor(value);
  if (notice !== null) expect(typeof notice).toBe("string");
});
`,
  );

  fixture(
    "e/recorder.ts",
    `const revoked: string[] = [];

const broker = {
  revoke: async (toolkit: string) => {
    revoked.push(toolkit);
    return true;
  },
};

test("a retired identity's apps are all revoked", async () => {
  await disconnect(broker);
  expect(true).toBe(true);
});
`,
  );

  fixture(
    "deep/down/f/stringify.ts",
    `test("nothing the vendor wrote survives the log", () => {
  expect(JSON.stringify(thrown, Object.keys(thrown))).not.toContain("SECRET");
});
`,
  );

  // The same six, written the way the fix cycle will write them.
  fixture(
    "clean/fixed.ts",
    `const seen: string[] = [];

const broker = {
  revoke: async (toolkit: string) => {
    seen.push(toolkit);
    return true;
  },
};

test("the refusal is refused", async () => {
  await expect(refuse()).rejects.toThrow(Boom);
});

test("a connection failure keeps status undefined", () => {
  const normalized = need(normalize(failure), "nothing normalized");
  expect(normalized.status).toBeUndefined();
});

test("an error with no body leaves name undefined", () => {
  expect(read()).toEqual({ status: 500 });
  expect(read()).not.toHaveProperty("name");
});

test("a sentence or nothing, never an object", () => {
  const notice = noticeFor(value);
  expect(notice === null || typeof notice === "string").toBe(true);
});

test("a retired identity's apps are all revoked", async () => {
  await disconnect(broker);
  expect(seen).toEqual(["gmail"]);
});

test("nothing the vendor wrote survives the log", () => {
  expect(JSON.stringify(thrown, ["message", "name"])).not.toContain("SECRET");
});
`,
  );
});

afterAll(() => {
  if (FIXTURES) rmSync(FIXTURES, { recursive: true, force: true });
});

test("(a) a discarded .rejects is seen, two directories down and all", () => {
  const offence = planted("a");
  expect(`${offence.file}:${offence.line}`).toBe("a/floating.ts:2");
  expect(offence.text).toContain("expect(refuse()).rejects.toThrow(Boom);");
});

test("(b) a `?.` subject under a matcher undefined satisfies is seen", () => {
  const offence = planted("b");
  expect(`${offence.file}:${offence.line}`).toBe("nested/deep/b/chain.ts:2");
  expect(offence.text).toContain(
    "expect(normalize(failure)?.status).toBeUndefined()",
  );
});

test("(c) an expected-undefined key in a toEqual literal is seen", () => {
  // Four physical lines, which is the reason this scan works in offsets and not in lines.
  const offence = planted("c");
  expect(`${offence.file}:${offence.line}`).toBe("c/equal.tsx:2");
  expect(offence.text).toContain("name: undefi");
});

test("(d) a test whose every assertion sits inside an `if` is seen", () => {
  const offence = planted("d");
  expect(`${offence.file}:${offence.line}`).toBe("d/guarded.tsx:1");
  expect(offence.text).toContain("const notice = noticeFor(value);");
});

test("(e) a recorder nothing ever reads is seen", () => {
  const offence = planted("e");
  expect(`${offence.file}:${offence.line}`).toBe("e/recorder.ts:1");
  expect(offence.text).toContain("const revoked: string[] = [];");
});

test("(f) JSON.stringify(x, Object.keys(x)) is seen", () => {
  const offence = planted("f");
  expect(`${offence.file}:${offence.line}`).toBe("deep/down/f/stringify.ts:2");
  expect(offence.text).toContain("JSON.stringify(thrown, Object.keys(thrown))");
});

/* NEGATIVE CONTROL. The same six written correctly, in a file the walk reaches, so a detector
 * that fires on everything fails here rather than passing six tests and one audit. */

test("the fixed counterparts of all six are reported as nothing", () => {
  expect(
    report(scanTree(FIXTURES).filter((o) => o.file.startsWith("clean/"))),
  ).toEqual([]);
  // And the file was genuinely read, rather than missed by the walk.
  expect(
    sourceFiles(FIXTURES, EXTENSIONS).map((f) => f.slice(FIXTURES.length + 1)),
  ).toContain("clean/fixed.ts");
});
