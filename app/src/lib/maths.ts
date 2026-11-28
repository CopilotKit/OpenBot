/**
 * Maths in a Bot's markdown, in the delimiters Streamdown's maths plugin reads.
 *
 * WHY. A model writing a formula in a chat writes LaTeX, and most write it the way LaTeX itself
 * does: `\( ... \)` inside a sentence and `\[ ... \]` on lines of their own. Markdown reads `\(`
 * and `\[` as an escaped bracket, so before this the reader saw "(P r / [1-(1+r)^{-n}])" with the
 * backslashes gone and the formula as source. Streamdown's maths plugin (remark-math and KaTeX)
 * reads `$$`: on lines of their own a formula set apart, inside a sentence a formula in the line.
 * So `\[ ... \]` that stands on its own lines becomes a `$$` block, and `\( ... \)`, or a `\[ ... \]`
 * in the middle of a sentence, becomes `$$ ... $$` in the line. Nothing else is rewritten.
 *
 * WHAT IT NEVER TOUCHES. Fenced code (``` or ~~~) and inline code keep every character, so code
 * that escapes a bracket stays code. A `$$ ... $$` already written is left as it is. A single `$` is
 * never maths (Streamdown's default), so "$25,000" and "$5 to $10" stay prices. An opener with no
 * closer before the end of its paragraph stays as written: while a reply streams, a formula is
 * drawn once its closer has arrived, and a stray `\(` in prose never swallows the rest of the
 * message. A backslash that is itself escaped (`\\(`) is not an opener.
 */

const FENCE = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})/;

/** The length of the run of `char` starting at `index`. */
function runAt(text: string, index: number, char: string): number {
  let end = index;
  while (text[end] === char) end += 1;
  return end - index;
}

/**
 * Where the closer of a `\(` or `\[` opened just before `from` starts, or -1. The closer is a `\)`
 * or `\]` whose backslash is not itself escaped, before the paragraph ends (a blank line).
 */
function closerFrom(text: string, from: number, close: ")" | "]"): number {
  const paragraphEnd = text.slice(from).search(/\n[ \t]*\n/);
  const end = paragraphEnd === -1 ? text.length : from + paragraphEnd;
  let index = from;
  while (index < end) {
    if (text[index] !== "\\") {
      index += 1;
      continue;
    }
    const run = runAt(text, index, "\\");
    const after = index + run;
    if (run % 2 === 1 && text[after] === close && after < end) return after - 1;
    index = after;
  }
  return -1;
}

/** The text from the start of the line `index` is on, up to `index`. */
function lineBefore(text: string, index: number): string {
  return text.slice(text.lastIndexOf("\n", index - 1) + 1, index);
}

/** The text from `index` to the end of its line. */
function lineAfter(text: string, index: number): string {
  const end = text.indexOf("\n", index);
  return text.slice(index, end === -1 ? text.length : end);
}

/**
 * A dollar sign inside a formula, as KaTeX reads one. Models write "\\(P=$25,000\\)" for a price
 * in a formula; a bare `$` there would end the `$$` early or reach KaTeX as an error.
 */
function escapeDollars(formula: string): string {
  return formula.replace(/(?<!\\)\$/g, "\\$$");
}

/**
 * A thousands separator, as KaTeX reads one. In maths a comma is punctuation and is followed by a
 * space, so "25,000" was drawn "25, 000"; `{,}` is the comma inside a number.
 */
function groupThousands(formula: string): string {
  return formula.replace(/(\d),(?=\d{3}(?!\d))/g, "$1{,}");
}

/** A formula's text, made ready for KaTeX. */
function forKatex(formula: string): string {
  return groupThousands(escapeDollars(formula));
}

/** A formula set apart, as a `$$` block at the indent its opener stood at. */
function displayBlock(formula: string, indent: string): string {
  const lines = forKatex(formula)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `${indent}${line}`);
  return `$$\n${lines.join("\n")}\n${indent}$$`;
}

/** A formula in the line. */
function inlineFormula(formula: string): string {
  return `$$${forKatex(formula.trim()).replace(/\s*\n\s*/g, " ")}$$`;
}

/** Prose, with code spans and `$$` maths kept as written and `\( \)` and `\[ \]` rewritten. */
function rewriteProse(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "`") {
      // A code span closes on a run of exactly as many backticks.
      const run = runAt(text, index, "`");
      let close = text.indexOf("`".repeat(run), index + run);
      while (close !== -1 && runAt(text, close, "`") !== run)
        close = text.indexOf("`".repeat(run), close + runAt(text, close, "`"));
      const end = close === -1 ? index + run : close + run;
      out += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === "$" && text[index + 1] === "$") {
      const close = text.indexOf("$$", index + 2);
      const end = close === -1 ? index + 2 : close + 2;
      out += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === "\\") {
      const run = runAt(text, index, "\\");
      const opener = index + run - 1;
      const kind = text[opener + 1];
      if (run % 2 === 1 && (kind === "(" || kind === "[")) {
        const from = opener + 2;
        const close = closerFrom(text, from, kind === "(" ? ")" : "]");
        const formula = close === -1 ? "" : text.slice(from, close);
        if (formula.trim()) {
          out += text.slice(index, opener);
          const indent = lineBefore(text, opener);
          const standsAlone =
            kind === "[" &&
            /^[ \t]*$/.test(indent) &&
            /^[ \t]*$/.test(lineAfter(text, close + 2));
          out += standsAlone
            ? displayBlock(formula, indent)
            : inlineFormula(formula);
          index = close + 2;
          continue;
        }
      }
      out += text.slice(index, index + run);
      index += run;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** `markdown` with `\( \)` and `\[ \]` maths written in the `$$` the maths plugin reads. */
export function withMathDelimiters(markdown: string): string {
  if (!markdown.includes("\\(") && !markdown.includes("\\[")) return markdown;
  const lines = markdown.split(/(?<=\n)/);
  let out = "";
  let prose = "";
  let fence: string | null = null;
  for (const line of lines) {
    const opened = FENCE.exec(line)?.[1];
    if (fence === null) {
      if (opened) {
        out += rewriteProse(prose) + line;
        prose = "";
        fence = opened;
      } else prose += line;
      continue;
    }
    out += line;
    // A fence closes on a run of the same character, at least as long, with nothing after it.
    if (
      opened &&
      opened[0] === fence[0] &&
      opened.length >= fence.length &&
      line.trim().replace(/^(?:>[ \t]*)*/, "") === opened
    )
      fence = null;
  }
  return out + rewriteProse(prose);
}

/** Whether markdown holds maths for the maths plugin to draw. */
export function hasMaths(markdown: string): boolean {
  return markdown.includes("$$");
}
