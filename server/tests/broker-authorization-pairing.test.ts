import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE PAIRING INVARIANT, asserted over every `ConnectedAppBroker` literal in the tree.
 *
 * A broker with `authorizations === null` answers `authorizationId: null`; a broker with a
 * non-null `authorizations` answers a non-null `authorizationId` on a successful mint. It is the
 * one way spec D24's binding (the attempt's `ar_…` equals the callback's `auth_id`) rots without a
 * type error: an adapter grows a flow surface and forgets the mint id.
 *
 * A literal is found by its `authorize` member — the one member every broker must have — and is
 * confirmed a broker by a `grantIsLocal` or `authorizations` sibling at the same indent. This reads
 * source text because the stubs are module-local and `server/tests` is outside `tsc`, so nothing
 * else can see them all.
 *
 * EVERY HEURISTIC HERE FAILS LOUD, NEVER QUIET. A guard that decides for itself which code to look
 * at is only as good as that decision, and a decision that silently drops the one adapter the
 * invariant exists for reads exactly like a pass. So: the shape this scan cannot read throws
 * instead of being skipped ({@link answersOf}), a broker-shaped literal with no `authorize` throws,
 * and {@link coverage} asserts by name that the production adapters are among the literals this
 * file actually checks rather than merely among the ones it found.
 */
const ROOT = join(import.meta.dir, "..");
const SELF = "broker-authorization-pairing.test.ts";
/**
 * THE WHOLE OF `src` AND `tests`, RECURSIVELY. A hand-listed directory is the same silent miss as a
 * hand-tuned heuristic: a broker literal written one directory over would simply not be asserted,
 * and that reads as a pass.
 */
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith(".ts") && e.name !== SELF
        ? [join(dir, e.name)]
        : [],
  );
const files = [...sources(join(ROOT, "tests")), ...sources(join(ROOT, "src"))];

type Literal = {
  where: string;
  authorizations: "null" | "flow";
  /** The object literals this `authorize` can ANSWER WITH; see {@link answersOf}. */
  answers: string[];
};

const indentOf = (l: string) => /^\s*/.exec(l)![0].length;

/**
 * A member line of an object literal: `name:`, `name(`, `async name(`, or the shorthand `name,`.
 * The shorthand matters for the member AFTER `authorize`, which is where its body ends.
 */
const MEMBER = /^\s*(async\s+)?\w+\??\s*([(:]|,\s*$|$)/;

/** The lines of the object literal whose members sit at `indent`, and which of them are members. */
function blockAt(lines: string[], at: number, indent: number) {
  let from = at;
  while (
    from > 0 &&
    (lines[from - 1]!.trim() === "" || indentOf(lines[from - 1]!) >= indent)
  )
    from--;
  let to = at;
  while (
    to < lines.length - 1 &&
    (lines[to + 1]!.trim() === "" || indentOf(lines[to + 1]!) >= indent)
  )
    to++;
  const block = lines.slice(from, to + 1);
  const members = block
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => indentOf(l) === indent && MEMBER.test(l));
  const named = (name: string) =>
    members.findIndex(({ l }) =>
      new RegExp(`^\\s*(async\\s+)?${name}\\s*([(:]|,\\s*$|$)`).test(l),
    );
  return { from, block, members, named };
}

/**
 * Comments are prose: `authorizationId` in a sentence is not an answer. The `//` strip refuses a
 * `//` that follows a colon so that a `"https://…"` inside a returned literal survives — eating it
 * would unbalance the braces this reads next.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/**
 * The object literals an `authorize` body can ANSWER WITH: `return {…}` and the concise `=> ({…})`.
 * Scoping to these is what keeps the seam's own `authorizationId: string | null` annotation, a
 * local `const authorizationId`, or a sentence in a comment from reading as an answer — and what
 * lets a shorthand `return { redirectUrl, authorizationId }` be read as the answer it is.
 *
 * `=> {` is a function body, not an answer; its `return`s are found by the `return` pass.
 */
function answersOf(body: string): string[] {
  const src = stripComments(body);
  const out: string[] = [];
  for (const m of src.matchAll(/\breturn\b|=>\s*\(/g)) {
    let i = m.index + m[0].length;
    while (i < src.length && /[\s(]/.test(src[i]!)) i++;
    if (src[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) {
        out.push(src.slice(i, j + 1));
        break;
      }
    }
  }
  return out;
}

function literalsIn(file: string): Literal[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const out: Literal[] = [];
  lines.forEach((line, at) => {
    const m = /^(\s*)(async\s+)?authorize\s*[(:]/.exec(line);
    if (!m) return;
    const indent = m[1]!.length;
    const { from, block, members, named } = blockAt(lines, at, indent);
    const g = named("grantIsLocal");
    const a = named("authorizations");
    // An `authorize` with neither sibling is somebody else's member — a vendor client's own
    // `authorize`, say — and not the seam this invariant is about.
    if (g < 0 && a < 0) return;
    // The seam's own interface declares these members too (`grantIsLocal: boolean;`). A declaration
    // is not a broker: the pairing lives in the literals that implement it, and a `;`-terminated
    // member is how a declaration gives itself away.
    if (
      [g, a].some((i) => i >= 0 && /;\s*$/.test(block[members[i]!.i]!.trim()))
    )
      return;
    const z = named("authorize");
    // The one literal that omits `authorizations` is composio-grants-for's deliberate
    // does-not-compile witness, which is then spread with `authorizations: null` — so an omission
    // is read as the null it is completed with there. That reading is the strict one: it demands
    // `authorizationId: null`, so a literal that omits the member AND mints an id fails loudly.
    const aLine = a < 0 ? "authorizations: null" : block[members[a]!.i]!;
    const end = z + 1 < members.length ? members[z + 1]!.i : block.length;
    const body = block.slice(members[z]!.i, end).join("\n");
    const answers = answersOf(body);
    // A SHAPE THIS CANNOT READ THROWS. `redirectUrl` in the body with no answer carrying it means
    // the mint is assembled somewhere this scan does not look, and silently skipping it is how a
    // guard comes to assert nothing.
    if (
      /\bredirectUrl\b/.test(stripComments(body)) &&
      !answers.some((ans) => /\bredirectUrl\b/.test(ans))
    ) {
      throw new Error(
        `${file.slice(ROOT.length + 1)}:${from + members[z]!.i + 1}: this authorize names redirectUrl but answers with a shape this guard cannot read; teach answersOf() the shape rather than leaving the literal unchecked.`,
      );
    }
    out.push({
      where: `${file.slice(ROOT.length + 1)}:${from + members[z]!.i + 1}`,
      authorizations: /authorizations:\s*null\b/.test(aLine) ? "null" : "flow",
      answers,
    });
  });
  return out;
}

/**
 * Every declared `grantIsLocal` on a broker-shaped literal must have landed in {@link literalsIn}'s
 * net. This is the net's own guard: the scan anchors on `authorize`, so a broker literal that grew
 * one without the other would otherwise go unexamined and read as a pass.
 */
function unreachedIn(file: string): string[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const out: string[] = [];
  lines.forEach((line, at) => {
    const m = /^(\s*)grantIsLocal\s*:\s*(true|false)\s*[,}]/.exec(line);
    if (!m) return;
    const { from, named } = blockAt(lines, at, m[1]!.length);
    // `{ key, grantIsLocal: true }` in a deployment config is not a broker.
    if (named("authorizations") < 0) return;
    if (named("authorize") >= 0) return;
    /*
     * A `stubBroker({ … })` WITHOUT an `authorize` IS NOT UNEXAMINED, it is unable to mint.
     *
     * This net exists because `literalsIn` anchors on `authorize`, so a hand-written literal that
     * declared the pair without one would slip past unchecked and read as a pass. The factory
     * inverts that risk: a member it is not given does not quietly answer a plausible shape, it
     * RECORDS THE CALL AND THROWS. So an omitted `authorize` here cannot mint an id, there is no
     * pairing to check, and flagging it would demand the caller write out a member whose whole
     * purpose is to be absent.
     *
     * The exemption is narrow on purpose: a `stubBroker` call that DOES provide `authorize` still
     * carries that member on its own line, so `literalsIn` finds and examines it exactly as it
     * does any other literal. Only the cannot-mint case is skipped.
     */
    if (/\bstubBroker\s*\(/.test(lines[from - 1] ?? "")) return;
    out.push(`${file.slice(ROOT.length + 1)}:${at + 1}`);
  });
  return out;
}

/** `none` is no `authorizationId` at all, which answers neither surface. */
function idOf(answer: string): "none" | "null" | "value" {
  const m = /\bauthorizationId\b\s*(?::\s*([^,}\n]+))?/.exec(answer);
  if (!m) return "none";
  if (m[1] === undefined) return "value"; // the shorthand `{ …, authorizationId }`
  return /^null\s*$/.test(m[1]) ? "null" : "value";
}

const literals = files.flatMap(literalsIn);
/** The literals actually asserted over: the ones whose `authorize` answers a url to visit. */
const minting = literals
  .map((l) => ({
    ...l,
    answers: l.answers.filter((a) => /\bredirectUrl\b/.test(a)),
  }))
  .filter((l) => l.answers.length > 0);
const coverage = minting.map((l) => l.where);

describe("authorizations and authorizationId are declared as a pair", () => {
  test("the scan reaches every broker-shaped literal", () => {
    expect(files.flatMap(unreachedIn)).toEqual([]);
  });

  test("the production adapters are among the literals CHECKED", () => {
    // Not merely among the ones found: the Arcade adapter is the one production broker with a
    // non-null `authorizations`, so if it is not here the flow half of this invariant is asserted
    // for nothing but stubs.
    expect(
      coverage.some((p) => p.startsWith("src/plugins/arcade-adapter.ts")),
    ).toBe(true);
    expect(
      coverage.some((p) =>
        p.startsWith("src/plugins/composio-client/consent.ts"),
      ),
    ).toBe(true);
    // A floor that notices this scan collapsing, not a count to keep up to date; it sits just under
    // what the tree holds today (28) rather than at a third of it.
    expect(minting.length).toBeGreaterThanOrEqual(25);
    // BOTH BRANCHES MUST BE INHABITED. An empty one is a branch asserted for nothing, which is the
    // state this guard was in when its only non-null-`authorizations` literal was being skipped.
    expect(minting.some((l) => l.authorizations === "null")).toBe(true);
    expect(minting.some((l) => l.authorizations === "flow")).toBe(true);
  });

  for (const literal of minting) {
    test(literal.where, () => {
      const want = literal.authorizations === "null" ? "null" : "value";
      for (const answer of literal.answers) {
        const said = answer.replace(/\s+/g, " ");
        expect(`${idOf(answer)} in ${said}`).toBe(`${want} in ${said}`);
      }
    });
  }
});
