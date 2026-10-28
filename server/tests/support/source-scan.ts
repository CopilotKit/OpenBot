// server/tests/support/source-scan.ts
/**
 * The four primitives every text-scanning guard needs, in one place: enumerate the files, strip the
 * comments, split into lines a pattern can be matched against.
 *
 * WHY THIS EXISTS. Five guards each grew their own copy of these, and every copy had the same shape
 * of blind spot — not in the pattern it matches, but in the text it ever gets to see:
 *
 *   - a NON-RECURSIVE `readdirSync`, so a rule stated over a directory silently stops at the first
 *     subdirectory somebody adds. {@link sourceFiles} walks.
 *   - a comment stripper that replaces a block comment with `""`, NEWLINES AND ALL, so every line
 *     after it is reported at the wrong number — or one that drops whole lines, which turns a
 *     trailing `// note` into the removal of the code it trails and can fail a guard on a line that
 *     holds no offence. {@link stripComments} blanks a comment in place: same bytes out as in, minus
 *     the comment, with every newline where it was.
 *   - a per-PHYSICAL-line match, so a prettier-wrapped `typeof search.x ===\n"string"` is two lines
 *     to the guard and one expression to the compiler, and the guard sees neither half.
 *     {@link logicalLines} joins a wrapped expression back up and reports the line it STARTED on.
 *
 * Each guard's positive control plants its offender in a file the enumerator already visits, which
 * is exactly why none of these were caught by the controls: a control sited that way proves the
 * matcher and says nothing about the enumerator. `source-scan.test.ts` is the contract test for the
 * enumerator half, over fixtures it writes itself.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every file under `root` whose name ends in one of `exts`, RECURSIVELY, sorted.
 *
 * Sorted so an offender list is stable, and recursive so `src/plugins/<dir>/x.ts` is scanned the day
 * it lands rather than the day somebody notices. Symlinks are not followed (a `node_modules` link is
 * not source).
 */
export function sourceFiles(root: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out.sort();
}

/**
 * Line and block comments removed, EVERY OTHER BYTE POSITION LEFT ALONE.
 *
 * A comment is overwritten with spaces and its newlines are kept, so line numbers — and columns —
 * are those of the real file. String literals are copied through untouched, so a `"// not a
 * comment"` or an `"https://host"` inside a string survives; a single- or double-quoted string is
 * taken to end at a newline, as it does in the language. Regex literals are not parsed, which is the
 * known limit: a regex holding `//` or `/*` can still be read as a comment.
 */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === c) {
          j++;
          break;
        }
        if (c !== "`" && text[j] === "\n") break;
        j++;
      }
      out += text.slice(i, j);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) out += text[i] === "\n" ? "\n" : " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** A logical line, and the 1-based PHYSICAL line it started on. */
export type LogicalLine = { line: number; text: string };

/** Brackets opened and not closed on this line, strings skipped. */
function bracketDelta(line: string): number {
  let delta = 0;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < line.length && line[i] !== c) i += line[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "(" || c === "[") delta++;
    else if (c === ")" || c === "]") delta--;
    i++;
  }
  return delta;
}

/** Ends on something that cannot end a statement, so the expression continues on the next line. */
const DANGLING = /(?:=>|[-+*%<>=!&|?:.,^~])$/;

/**
 * The most physical lines one logical line may absorb.
 *
 * A wrapped EXPRESSION is short — prettier breaks at 80 columns, so the two or three lines of a
 * `typeof x ===` / `"string"` or an `eq(` / arg / arg / `)` are the whole population this exists
 * for. A bracket, by contrast, can stay open for the length of a route handler, and joining a
 * hundred-line `routes.get("/", …)` into one line would report every offence inside it at the
 * handler's first line and splice its docblocks onto its code. So the join stops here and the
 * remaining lines start a new logical line: a long call is read as the many lines it is written on,
 * which is what the old per-physical-line scan did anyway.
 */
const MAX_JOIN = 5;

/**
 * Physical lines joined back into the expressions they were wrapped out of.
 *
 * Prettier breaks a long expression at an operator or inside a bracket, so `typeof search.x ===`
 * and `"string"` are one decision written on two lines. A guard matching per physical line sees
 * neither half and reports green. Lines are joined with a single space while a bracket is open or
 * the line ends dangling, for at most {@link MAX_JOIN} physical lines; `{` and `}` are NOT counted,
 * so a block body stays many logical lines rather than collapsing into one. Comments do not get a
 * vote on where a logical line ends — their brackets and their trailing operators are discounted,
 * though their text is kept in the joined line, since whether prose is an offence is the caller's
 * rule and not this function's. The reported `line` is where the logical line STARTED, which is the
 * line a reader is sent to.
 */
export function logicalLines(text: string): LogicalLine[] {
  const out: LogicalLine[] = [];
  const physical = text.split("\n");
  let start = 0;
  let buffer = "";
  let depth = 0;
  let open = false;
  for (let i = 0; i < physical.length; i++) {
    const raw = physical[i];
    if (!open) {
      start = i;
      buffer = raw;
      depth = 0;
    } else {
      buffer += ` ${raw.trim()}`;
    }
    const code = stripComments(raw);
    depth += bracketDelta(code);
    open = depth > 0 || DANGLING.test(code.trimEnd());
    if (open && i - start + 1 >= MAX_JOIN) open = false;
    if (open && i < physical.length - 1) continue;
    out.push({ line: start + 1, text: buffer });
    open = false;
  }
  return out;
}
